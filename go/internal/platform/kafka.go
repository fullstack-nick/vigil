package platform

import (
	"context"
	"crypto/tls"
	"fmt"
	"strings"
	"time"

	"github.com/googleapis/managedkafka/sasl-plain-access-token/segmentio/saslplainoauthmechanism"
	"github.com/segmentio/kafka-go"
)

type KafkaConfig struct {
	Brokers  []string
	AuthMode string
}

func ParseBrokers(value string) []string {
	var brokers []string
	for _, broker := range strings.Split(value, ",") {
		if trimmed := strings.TrimSpace(broker); trimmed != "" {
			brokers = append(brokers, trimmed)
		}
	}
	return brokers
}

func NewKafkaDialer(ctx context.Context, config KafkaConfig) (*kafka.Dialer, error) {
	dialer := &kafka.Dialer{
		Timeout:   15 * time.Second,
		DualStack: true,
	}
	if config.AuthMode == "gcp-oauth" {
		mechanism, err := saslplainoauthmechanism.NewADCMechanism(ctx)
		if err != nil {
			return nil, fmt.Errorf("create managed kafka ADC mechanism: %w", err)
		}
		dialer.TLS = &tls.Config{MinVersion: tls.VersionTLS12}
		dialer.SASLMechanism = mechanism
	}
	return dialer, nil
}

func NewKafkaWriter(ctx context.Context, config KafkaConfig) (*kafka.Writer, error) {
	dialer, err := NewKafkaDialer(ctx, config)
	if err != nil {
		return nil, err
	}
	transport := &kafka.Transport{
		Dial: dialer.DialFunc,
	}
	if config.AuthMode == "gcp-oauth" {
		transport.TLS = dialer.TLS
		transport.SASL = dialer.SASLMechanism
	}
	return &kafka.Writer{
		Addr:                   kafka.TCP(config.Brokers...),
		Transport:              transport,
		Balancer:               &kafka.Hash{},
		RequiredAcks:           kafka.RequireAll,
		Async:                  false,
		AllowAutoTopicCreation: false,
		BatchTimeout:           20 * time.Millisecond,
		WriteTimeout:           30 * time.Second,
	}, nil
}
