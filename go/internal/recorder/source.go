package recorder

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

func ValidateSource(ctx context.Context, rawURL string, allowedHosts map[string]struct{}) error {
	parsed, err := validateSourceURL(rawURL, allowedHosts)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return fmt.Errorf("create HLS preflight request: %w", err)
	}
	client := &http.Client{
		Timeout: 10 * time.Second,
		CheckRedirect: func(request *http.Request, _ []*http.Request) error {
			_, redirectErr := validateSourceURL(request.URL.String(), allowedHosts)
			return redirectErr
		},
	}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("HLS source preflight failed: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("HLS source preflight returned status %d", response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 2<<20))
	if err != nil {
		return fmt.Errorf("read HLS playlist: %w", err)
	}
	if !strings.HasPrefix(strings.TrimSpace(string(data)), "#EXTM3U") {
		return errors.New("configured source did not return an HLS playlist")
	}
	return nil
}

func validateSourceURL(rawURL string, allowedHosts map[string]struct{}) (*url.URL, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return nil, errors.New("configured source URL is invalid")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, errors.New("configured source URL must use HTTP(S)")
	}
	if parsed.User != nil {
		return nil, errors.New("configured source URL must not contain credentials")
	}
	host := strings.ToLower(parsed.Hostname())
	if host == "" {
		return nil, errors.New("configured source URL has no host")
	}
	if host == "metadata.google.internal" || host == "169.254.169.254" {
		return nil, errors.New("metadata destinations are forbidden")
	}
	if _, allowed := allowedHosts[host]; !allowed {
		return nil, errors.New("configured source host is outside the deployment allowlist")
	}
	return parsed, nil
}
