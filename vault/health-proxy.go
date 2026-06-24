package main

import (
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
)

func main() {
	listenAddr := envOrDefault("HEALTH_PROXY_ADDR", ":8200")
	targetAddr := envOrDefault("OPENBAO_UPSTREAM_ADDR", "http://127.0.0.1:8201")

	target, err := url.Parse(targetAddr)
	if err != nil {
		log.Fatalf("invalid OPENBAO_UPSTREAM_ADDR %q: %v", targetAddr, err)
	}

	proxy := httputil.NewSingleHostReverseProxy(target)
	mux := http.NewServeMux()
	mux.HandleFunc("/railwayhealth", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok\n"))
	})
	mux.Handle("/", proxy)

	log.Printf("health proxy listening on %s, proxying to %s", listenAddr, target)
	if err := http.ListenAndServe(listenAddr, mux); err != nil {
		log.Fatalf("health proxy failed: %v", err)
	}
}

func envOrDefault(name string, fallback string) string {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	return value
}
