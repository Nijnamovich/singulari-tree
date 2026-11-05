package http

import (
	"crypto/subtle"
	"encoding/json"
	"net/http"

	"github.com/SingulariTree/go-core/internal/service"
)

// Handler is the HTTP fallback adapter (JSON, localhost-only, token required).
// Real implementation mirrors gRPC methods over POST /v1/*.
type Handler struct {
	repoSvc  *service.RepoService
	gitSvc   *service.GitService
	graphSvc *service.GraphService
	token    string
}

// NewHandler creates a fallback HTTP handler.
func NewHandler(repoSvc *service.RepoService, gitSvc *service.GitService, graphSvc *service.GraphService, token string) *Handler {
	return &Handler{repoSvc: repoSvc, gitSvc: gitSvc, graphSvc: graphSvc, token: token}
}

// Register mounts routes onto mux.
func (h *Handler) Register(mux *http.ServeMux) {
	mux.HandleFunc("/v1/ping", h.handlePing)
	mux.HandleFunc("/health", h.handlePing)
}

func (h *Handler) handlePing(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
}

// AuthMiddleware validates Bearer token (localhost-only check done at listener level).
func (h *Handler) AuthMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if h.token == "" {
			next.ServeHTTP(w, r)
			return
		}
		if !secureEqual(r.Header.Get("Authorization"), "Bearer "+h.token) {
			http.Error(w, `{"error":{"code":"UNAUTHENTICATED","message":"invalid token"}}`, http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// secureEqual compares a and b in constant time (length-checked first) so body
// token validation does not leak information through timing. Behaviour is
// identical to == for the boolean result.
func secureEqual(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}
