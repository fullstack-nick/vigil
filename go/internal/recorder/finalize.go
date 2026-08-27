package recorder

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

type FinalMedia struct {
	LocalPath      string
	ObjectName     string
	Size           int64
	DurationMillis uint64
	SegmentCount   uint32
}

func Finalize(ctx context.Context, config Config, store *ObjectStore, segments []StoredSegment) (FinalMedia, error) {
	finalizeDirectory := filepath.Join(config.SpoolDirectory, "finalize")
	if err := os.MkdirAll(finalizeDirectory, 0o750); err != nil {
		return FinalMedia{}, err
	}
	sort.Slice(segments, func(left, right int) bool { return segments[left].Index < segments[right].Index })
	var concat strings.Builder
	for _, segment := range segments {
		localPath := filepath.Join(finalizeDirectory, fmt.Sprintf("segment-%06d.ts", segment.Index))
		if err := store.Download(ctx, segment.ObjectName, localPath); err != nil {
			return FinalMedia{}, err
		}
		concat.WriteString("file '")
		concat.WriteString(filepath.ToSlash(localPath))
		concat.WriteString("'\n")
	}
	concatPath := filepath.Join(finalizeDirectory, "segments.txt")
	if err := os.WriteFile(concatPath, []byte(concat.String()), 0o600); err != nil {
		return FinalMedia{}, err
	}
	finalPath := filepath.Join(finalizeDirectory, "recording.mp4")
	command := exec.CommandContext(ctx, config.FFmpegPath,
		"-hide_banner", "-loglevel", "error", "-nostdin", "-y",
		"-f", "concat", "-safe", "0", "-i", concatPath,
		"-c", "copy", "-movflags", "+faststart", finalPath,
	)
	command.Stdout = nil
	command.Stderr = nil
	if err := command.Run(); err != nil {
		return FinalMedia{}, fmt.Errorf("finalize MP4: %w", err)
	}
	codec, err := exec.CommandContext(ctx, config.FFprobePath,
		"-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name",
		"-of", "default=nw=1:nk=1", finalPath,
	).Output()
	if err != nil || strings.TrimSpace(string(codec)) != "h264" {
		return FinalMedia{}, fmt.Errorf("final MP4 validation did not find H.264 video")
	}
	durationOutput, err := exec.CommandContext(ctx, config.FFprobePath,
		"-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", finalPath,
	).Output()
	if err != nil {
		return FinalMedia{}, fmt.Errorf("probe final duration: %w", err)
	}
	durationSeconds, err := strconv.ParseFloat(strings.TrimSpace(string(durationOutput)), 64)
	if err != nil || durationSeconds <= 0 {
		return FinalMedia{}, fmt.Errorf("final MP4 has invalid duration")
	}
	objectName := "vod/" + config.RecordingID + "/recording.mp4"
	size, _, err := store.UploadFinal(ctx, finalPath, objectName)
	if err != nil {
		return FinalMedia{}, err
	}
	return FinalMedia{
		LocalPath:      finalPath,
		ObjectName:     objectName,
		Size:           size,
		DurationMillis: uint64(durationSeconds * 1000),
		SegmentCount:   uint32(len(segments)),
	}, nil
}
