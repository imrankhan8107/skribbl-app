package main

import (
	"encoding/json"
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	dto "github.com/prometheus/client_model/go"
)

// ─── Prometheus Metrics ──────────────────────────────────────────────────────

var (
	// grpcStreamsActive counts the number of currently open Room_Streams.
	grpcStreamsActive = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "grpc_streams_active",
		Help: "Number of currently open Room_Streams",
	})

	// grpcStreamErrorsTotal counts stream failures by error type.
	grpcStreamErrorsTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "grpc_stream_errors_total",
		Help: "Stream failures by error type",
	}, []string{"error_type"})

	// grpcMessagesPerStream tracks messages multiplexed per stream per minute.
	grpcMessagesPerStream = prometheus.NewHistogram(prometheus.HistogramOpts{
		Name:    "grpc_messages_per_stream",
		Help:    "Messages multiplexed per stream per minute",
		Buckets: prometheus.ExponentialBuckets(1, 2, 12),
	})

	// grpcFallbackActivationsTotal counts how many times Fallback_Mode was activated.
	grpcFallbackActivationsTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "grpc_fallback_activations_total",
		Help: "Number of times Fallback_Mode was activated",
	})
)

func init() {
	prometheus.MustRegister(grpcStreamsActive)
	prometheus.MustRegister(grpcStreamErrorsTotal)
	prometheus.MustRegister(grpcMessagesPerStream)
	prometheus.MustRegister(grpcFallbackActivationsTotal)
}

// ─── Helper Functions ────────────────────────────────────────────────────────

// IncrementStreamsActive increments the active gRPC streams gauge by 1.
func IncrementStreamsActive() {
	grpcStreamsActive.Inc()
}

// DecrementStreamsActive decrements the active gRPC streams gauge by 1.
func DecrementStreamsActive() {
	grpcStreamsActive.Dec()
}

// RecordStreamError increments the stream error counter for the given error type.
// Valid error types: "transport_error", "timeout", "buffer_overflow".
func RecordStreamError(errorType string) {
	grpcStreamErrorsTotal.WithLabelValues(errorType).Inc()
}

// ObserveMessagesPerStream records the number of messages multiplexed on a stream.
func ObserveMessagesPerStream(count float64) {
	grpcMessagesPerStream.Observe(count)
}

// IncrementFallbackActivations increments the fallback activation counter by 1.
func IncrementFallbackActivations() {
	grpcFallbackActivationsTotal.Inc()
}

// ─── HTTP Handlers ───────────────────────────────────────────────────────────

// RegisterMetricsHandler registers the Prometheus metrics endpoint on the given mux.
// It adds the /metrics endpoint serving Prometheus exposition format.
func RegisterMetricsHandler(mux *http.ServeMux) {
	mux.Handle("/metrics", promhttp.Handler())
}

// MetricsSummary returns a map of current gRPC metric values for inclusion
// in the /health JSON response.
func MetricsSummary() map[string]interface{} {
	summary := map[string]interface{}{
		"grpc_streams_active":            getGaugeValue(grpcStreamsActive),
		"grpc_fallback_activations_total": getCounterValue(grpcFallbackActivationsTotal),
		"grpc_stream_errors": map[string]float64{
			"transport_error": getCounterVecValue(grpcStreamErrorsTotal, "transport_error"),
			"timeout":         getCounterVecValue(grpcStreamErrorsTotal, "timeout"),
			"buffer_overflow": getCounterVecValue(grpcStreamErrorsTotal, "buffer_overflow"),
		},
	}
	return summary
}

// getGaugeValue reads the current value of a Prometheus gauge.
func getGaugeValue(g prometheus.Gauge) float64 {
	m := &dto.Metric{}
	if err := g.Write(m); err != nil {
		return 0
	}
	return m.GetGauge().GetValue()
}

// getCounterValue reads the current value of a Prometheus counter.
func getCounterValue(c prometheus.Counter) float64 {
	m := &dto.Metric{}
	if err := c.Write(m); err != nil {
		return 0
	}
	return m.GetCounter().GetValue()
}

// getCounterVecValue reads the current value of a specific label in a CounterVec.
func getCounterVecValue(cv *prometheus.CounterVec, errorType string) float64 {
	m := &dto.Metric{}
	counter, err := cv.GetMetricWithLabelValues(errorType)
	if err != nil {
		return 0
	}
	if err := counter.Write(m); err != nil {
		return 0
	}
	return m.GetCounter().GetValue()
}

// HandleHealthWithMetrics wraps the /health endpoint to include gRPC metrics summary.
func HandleHealthWithMetrics(gw *Gateway) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		health := map[string]interface{}{
			"status":          "ok",
			"active_clients":  activeClients.Load(),
			"active_backends": activeBackends.Load(),
			"total_connects":  totalConnects.Load(),
			"total_errors":    totalErrors.Load(),
			"grpc_enabled":    true,
			"grpc_metrics":    MetricsSummary(),
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(health)
	}
}
