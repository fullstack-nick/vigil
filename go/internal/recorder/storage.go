package recorder

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"os"
	"path/filepath"

	"cloud.google.com/go/storage"
	"google.golang.org/api/googleapi"
	"google.golang.org/api/iterator"
)

type StoredSegment struct {
	Index      uint32
	ObjectName string
	Size       int64
	CRC32C     uint32
}

type ObjectStore struct {
	client *storage.Client
	bucket *storage.BucketHandle
}

func NewObjectStore(ctx context.Context, bucketName string) (*ObjectStore, error) {
	client, err := storage.NewClient(ctx)
	if err != nil {
		return nil, fmt.Errorf("create storage client: %w", err)
	}
	return &ObjectStore{client: client, bucket: client.Bucket(bucketName)}, nil
}

func (store *ObjectStore) Close() error { return store.client.Close() }

func (store *ObjectStore) UploadSegment(ctx context.Context, localPath, objectName string, index uint32) (StoredSegment, error) {
	size, checksum, err := store.uploadFile(ctx, localPath, objectName, "video/MP2T")
	if err != nil {
		return StoredSegment{}, err
	}
	return StoredSegment{Index: index, ObjectName: objectName, Size: size, CRC32C: checksum}, nil
}

func (store *ObjectStore) UploadFinal(ctx context.Context, localPath, objectName string) (int64, uint32, error) {
	return store.uploadFile(ctx, localPath, objectName, "video/mp4")
}

func (store *ObjectStore) uploadFile(ctx context.Context, localPath, objectName, contentType string) (int64, uint32, error) {
	file, err := os.Open(localPath)
	if err != nil {
		return 0, 0, fmt.Errorf("open upload source: %w", err)
	}
	defer file.Close()
	stat, err := file.Stat()
	if err != nil {
		return 0, 0, fmt.Errorf("stat upload source: %w", err)
	}
	hash := crc32.New(crc32.MakeTable(crc32.Castagnoli))
	object := store.bucket.Object(objectName).If(storage.Conditions{DoesNotExist: true})
	writer := object.NewWriter(ctx)
	writer.ContentType = contentType
	writer.ChunkSize = 8 << 20
	_, copyErr := io.Copy(io.MultiWriter(writer, hash), file)
	closeErr := writer.Close()
	checksum := hash.Sum32()
	if copyErr == nil && closeErr == nil {
		return stat.Size(), checksum, nil
	}
	uploadErr := copyErr
	if uploadErr == nil {
		uploadErr = closeErr
	}
	if !isPreconditionFailure(uploadErr) {
		return 0, 0, fmt.Errorf("upload %s: %w", objectName, uploadErr)
	}
	attrs, attrsErr := store.bucket.Object(objectName).Attrs(ctx)
	if attrsErr != nil {
		return 0, 0, fmt.Errorf("inspect existing object %s: %w", objectName, attrsErr)
	}
	if attrs.Size != stat.Size() || attrs.CRC32C != checksum {
		return 0, 0, fmt.Errorf("integrity conflict for existing object %s", objectName)
	}
	return stat.Size(), checksum, nil
}

func (store *ObjectStore) Download(ctx context.Context, objectName, localPath string) error {
	reader, err := store.bucket.Object(objectName).NewReader(ctx)
	if err != nil {
		return fmt.Errorf("open object %s: %w", objectName, err)
	}
	defer reader.Close()
	if err := os.MkdirAll(filepath.Dir(localPath), 0o750); err != nil {
		return err
	}
	file, err := os.Create(localPath)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(file, reader)
	closeErr := file.Close()
	if copyErr != nil {
		return copyErr
	}
	return closeErr
}

func (store *ObjectStore) DeleteRecording(ctx context.Context, recordingID string) error {
	for _, prefix := range []string{"raw/" + recordingID + "/", "vod/" + recordingID + "/"} {
		iterator := store.bucket.Objects(ctx, &storage.Query{Prefix: prefix})
		for {
			attrs, err := iterator.Next()
			if errors.Is(err, iteratorpkgDone()) {
				break
			}
			if err != nil {
				return fmt.Errorf("list cleanup prefix %s: %w", prefix, err)
			}
			if err := store.bucket.Object(attrs.Name).Delete(ctx); err != nil && !errors.Is(err, storage.ErrObjectNotExist) {
				return fmt.Errorf("delete object %s: %w", attrs.Name, err)
			}
		}
	}
	return nil
}

func CRC32CBase64(value uint32) string {
	bytes := make([]byte, 4)
	binary.BigEndian.PutUint32(bytes, value)
	return base64.StdEncoding.EncodeToString(bytes)
}

func isPreconditionFailure(err error) bool {
	var apiError *googleapi.Error
	return errors.As(err, &apiError) && apiError.Code == 412
}

// Kept behind a function to avoid shadowing iterator variables in cleanup loops.
func iteratorpkgDone() error { return iterator.Done }
