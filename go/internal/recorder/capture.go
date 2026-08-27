package recorder

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type SegmentPublisher func(context.Context, StoredSegment) error

type segmentTask struct {
	index      uint32
	localPath  string
	objectName string
}

type uploadResult struct {
	segment StoredSegment
	err     error
}

func Capture(
	ctx context.Context,
	config Config,
	sourceURL string,
	storagePrefix string,
	store *ObjectStore,
	publish SegmentPublisher,
) ([]StoredSegment, error) {
	if err := os.MkdirAll(config.SpoolDirectory, 0o750); err != nil {
		return nil, fmt.Errorf("create spool: %w", err)
	}
	segmentPattern := filepath.Join(config.SpoolDirectory, "segment-%06d.ts")
	playlistPath := filepath.Join(config.SpoolDirectory, "capture.m3u8")
	command := exec.Command(config.FFmpegPath,
		"-hide_banner", "-loglevel", "error", "-nostdin", "-y",
		"-protocol_whitelist", "http,https,tcp,tls,crypto",
		"-i", sourceURL,
		"-t", strconv.FormatFloat(config.MaxDuration.Seconds(), 'f', 0, 64),
		"-map", "0:v:0", "-map", "0:a:0?", "-c", "copy",
		"-f", "hls", "-hls_time", "5", "-hls_list_size", "0",
		"-hls_flags", "temp_file+independent_segments",
		"-hls_segment_filename", segmentPattern,
		playlistPath,
	)
	command.Stdout = io.Discard
	command.Stderr = io.Discard // Source URLs and query strings must never enter logs.
	if err := command.Start(); err != nil {
		return nil, fmt.Errorf("start ffmpeg: %w", err)
	}
	processDone := make(chan error, 1)
	go func() { processDone <- command.Wait() }()

	uploadCtx, cancelUploads := context.WithCancel(ctx)
	defer cancelUploads()
	tasks := make(chan segmentTask, 6)
	results := make(chan uploadResult, 256)
	var uploaders sync.WaitGroup
	for range 2 {
		uploaders.Add(1)
		go func() {
			defer uploaders.Done()
			for task := range tasks {
				segment, err := store.UploadSegment(uploadCtx, task.localPath, task.objectName, task.index)
				if err == nil {
					err = publish(uploadCtx, segment)
				}
				if err == nil {
					err = os.Remove(task.localPath)
				}
				results <- uploadResult{segment: segment, err: err}
			}
		}()
	}

	seen := make(map[string]struct{})
	ticker := time.NewTicker(350 * time.Millisecond)
	defer ticker.Stop()
	var segments []StoredSegment
	var terminalErr error
	running := true

	for running {
		select {
		case <-ctx.Done():
			terminalErr = context.Cause(ctx)
			gracefulStop(command.Process, processDone)
			running = false
		case err := <-processDone:
			if err != nil {
				terminalErr = fmt.Errorf("ffmpeg capture exited: %w", err)
			}
			time.Sleep(200 * time.Millisecond)
			if enqueueErr := enqueueSegments(ctx, config, storagePrefix, seen, tasks); enqueueErr != nil && terminalErr == nil {
				terminalErr = enqueueErr
			}
			running = false
		case result := <-results:
			if result.err != nil && terminalErr == nil {
				terminalErr = fmt.Errorf("segment upload pipeline: %w", result.err)
				cancelUploads()
				gracefulStop(command.Process, processDone)
				running = false
			} else if result.err == nil {
				segments = append(segments, result.segment)
			}
		case <-ticker.C:
			if spoolBytes, err := directoryBytes(config.SpoolDirectory); err != nil {
				terminalErr = err
				gracefulStop(command.Process, processDone)
				running = false
			} else if spoolBytes > config.MaximumSpoolBytes {
				terminalErr = errors.New("SPOOL_EXHAUSTED: queued media exceeded the 512 MiB budget")
				gracefulStop(command.Process, processDone)
				running = false
			} else if err := enqueueSegments(ctx, config, storagePrefix, seen, tasks); err != nil {
				terminalErr = err
				gracefulStop(command.Process, processDone)
				running = false
			}
		}
	}
	close(tasks)
	uploaders.Wait()
	close(results)
	for result := range results {
		if result.err != nil && terminalErr == nil {
			terminalErr = result.err
		}
		if result.err == nil {
			segments = append(segments, result.segment)
		}
	}
	if terminalErr != nil {
		return nil, terminalErr
	}
	if len(segments) == 0 {
		return nil, errors.New("NO_SEGMENTS: ffmpeg produced no complete segments")
	}
	sort.Slice(segments, func(left, right int) bool { return segments[left].Index < segments[right].Index })
	for index, segment := range segments {
		if segment.Index != uint32(index+1) {
			return nil, fmt.Errorf("segment sequence has a gap before index %d", segment.Index)
		}
	}
	return segments, nil
}

func enqueueSegments(ctx context.Context, config Config, prefix string, seen map[string]struct{}, tasks chan<- segmentTask) error {
	matches, err := filepath.Glob(filepath.Join(config.SpoolDirectory, "segment-*.ts"))
	if err != nil {
		return err
	}
	sort.Strings(matches)
	for _, path := range matches {
		if _, exists := seen[path]; exists {
			continue
		}
		info, err := os.Stat(path)
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() || info.Size() == 0 {
			continue
		}
		base := strings.TrimSuffix(strings.TrimPrefix(filepath.Base(path), "segment-"), ".ts")
		parsed, err := strconv.ParseUint(base, 10, 32)
		if err != nil {
			return fmt.Errorf("parse segment number %s: %w", base, err)
		}
		index := uint32(parsed) + 1
		seen[path] = struct{}{}
		task := segmentTask{index: index, localPath: path, objectName: fmt.Sprintf("%s/segment-%06d.ts", prefix, index)}
		select {
		case tasks <- task:
		case <-ctx.Done():
			return context.Cause(ctx)
		}
	}
	return nil
}

func directoryBytes(root string) (int64, error) {
	var total int64
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		total += info.Size()
		return nil
	})
	return total, err
}

func gracefulStop(process *os.Process, done <-chan error) {
	if process == nil {
		return
	}
	_ = process.Signal(os.Interrupt)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		_ = process.Kill()
		select {
		case <-done:
		case <-time.After(time.Second):
		}
	}
}
