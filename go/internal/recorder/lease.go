package recorder

import (
	"context"
	"crypto/tls"
	"fmt"
	"strings"
	"time"

	recordingv1 "github.com/fullstack-nick/vigil/go/gen/vigil/recording/v1"
	"golang.org/x/oauth2"
	"google.golang.org/api/idtoken"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	grpcoauth "google.golang.org/grpc/credentials/oauth"
)

type Lease struct {
	SourceURL     string
	StoragePrefix string
	ExpiresAt     time.Time
}

type LeaseClient struct {
	connection *grpc.ClientConn
	client     recordingv1.RecordingLeaseServiceClient
	config     Config
}

func NewLeaseClient(ctx context.Context, config Config) (*LeaseClient, error) {
	options := []grpc.DialOption{}
	if config.LeaseInsecure {
		options = append(options, grpc.WithTransportCredentials(insecure.NewCredentials()))
	} else {
		tokenSource, err := idtoken.NewTokenSource(ctx, config.LeaseAudience)
		if err != nil {
			return nil, fmt.Errorf("create Cloud Run identity token source: %w", err)
		}
		options = append(options,
			grpc.WithTransportCredentials(credentials.NewTLS(&tls.Config{MinVersion: tls.VersionTLS12})),
			grpc.WithPerRPCCredentials(grpcoauth.TokenSource{TokenSource: oauth2.ReuseTokenSource(nil, tokenSource)}),
		)
	}
	connection, err := grpc.NewClient(config.LeaseEndpoint, options...)
	if err != nil {
		return nil, fmt.Errorf("create lease gRPC client: %w", err)
	}
	return &LeaseClient{connection: connection, client: recordingv1.NewRecordingLeaseServiceClient(connection), config: config}, nil
}

func (client *LeaseClient) Close() error { return client.connection.Close() }

func (client *LeaseClient) Acquire(ctx context.Context) (Lease, string, error) {
	requestCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	response, err := client.client.AcquireRecordingLease(requestCtx, &recordingv1.AcquireRecordingLeaseRequest{
		RecordingId: client.config.RecordingID,
		AttemptId:   client.config.AttemptID,
		WorkerId:    client.config.WorkerID,
		JobName:     client.config.JobName,
	})
	if err != nil {
		return Lease{}, "", fmt.Errorf("acquire recording lease: %w", err)
	}
	if !response.GetAuthorized() {
		return Lease{}, response.GetDenialReason(), nil
	}
	if response.GetLeaseExpiresAt() == nil {
		return Lease{}, "", fmt.Errorf("authorized lease omitted expiration")
	}
	return Lease{
		SourceURL:     response.GetSourceUrl(),
		StoragePrefix: response.GetStoragePrefix(),
		ExpiresAt:     response.GetLeaseExpiresAt().AsTime(),
	}, "", nil
}

func (client *LeaseClient) Watch(ctx context.Context, initialExpiry time.Time, cancel context.CancelCauseFunc) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	nextRenewal := time.Now().Add(15 * time.Second)
	expiresAt := initialExpiry
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			if now.After(expiresAt.Add(-5 * time.Second)) {
				cancel(fmt.Errorf("LEASE_EXPIRED: renewal did not succeed before watchdog deadline"))
				return
			}
			if now.Before(nextRenewal) {
				continue
			}
			requestCtx, requestCancel := context.WithTimeout(ctx, 8*time.Second)
			response, err := client.client.RenewRecordingLease(requestCtx, &recordingv1.RenewRecordingLeaseRequest{
				RecordingId: client.config.RecordingID,
				AttemptId:   client.config.AttemptID,
				WorkerId:    client.config.WorkerID,
			})
			requestCancel()
			nextRenewal = now.Add(3 * time.Second)
			if err != nil {
				continue
			}
			if !response.GetAuthorized() {
				cancel(fmt.Errorf("LEASE_DENIED:%s", response.GetDenialReason()))
				return
			}
			if response.GetLeaseExpiresAt() == nil {
				continue
			}
			expiresAt = response.GetLeaseExpiresAt().AsTime()
			nextRenewal = now.Add(15 * time.Second)
		}
	}
}

func (client *LeaseClient) Release(ctx context.Context, terminalReason string) error {
	requestCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	_, err := client.client.ReleaseRecordingLease(requestCtx, &recordingv1.ReleaseRecordingLeaseRequest{
		RecordingId:    client.config.RecordingID,
		AttemptId:      client.config.AttemptID,
		WorkerId:       client.config.WorkerID,
		TerminalReason: terminalReason,
	})
	if err != nil {
		return fmt.Errorf("release recording lease: %w", err)
	}
	return nil
}

func DenialReason(cause error) string {
	if cause == nil {
		return ""
	}
	message := cause.Error()
	if strings.HasPrefix(message, "LEASE_DENIED:") {
		return strings.TrimPrefix(message, "LEASE_DENIED:")
	}
	if strings.HasPrefix(message, "LEASE_EXPIRED:") {
		return "LEASE_EXPIRED"
	}
	return ""
}
