CARGO ?= cargo
PREFIX ?= /usr/local
BINDIR ?= $(PREFIX)/bin
TARGET_DIR := target/release
BINS := ap-browser ap-browser-host ap-browser-bridge

.PHONY: all build install test fmt clippy check

all: build

build:
	$(CARGO) build --workspace --release

test:
	$(CARGO) test --workspace
	node --test --test-concurrency=1 extension/*.test.mjs tests/*.test.mjs host/src/recording/*.test.mjs

fmt:
	$(CARGO) fmt --check

clippy:
	$(CARGO) clippy --workspace --all-targets -- -D warnings

check: fmt clippy test

install: build
	@mkdir -p "$(BINDIR)"
	@for b in $(BINS); do \
		install -m 755 "$(TARGET_DIR)/$$b" "$(BINDIR)/$$b"; \
		if command -v codesign >/dev/null 2>&1; then \
			codesign --force --sign - "$(BINDIR)/$$b" >/dev/null 2>&1 || true; \
		fi; \
		echo "installed $(BINDIR)/$$b"; \
	done
	@manifest=""; \
	case "$$(uname -s)" in \
		Darwin) manifest="$$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.apbrowser.connect.json" ;; \
		Linux) manifest="$${XDG_CONFIG_HOME:-$$HOME/.config}/google-chrome/NativeMessagingHosts/com.apbrowser.connect.json" ;; \
	esac; \
	if [ -n "$$manifest" ] && [ -f "$$manifest" ]; then \
		manifest_host=$$(sed -n 's/.*"path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$$manifest" | head -1); \
		if [ -n "$$manifest_host" ] && [ "$$manifest_host" != "$(BINDIR)/ap-browser-host" ]; then \
			echo "note: Chrome native messaging manifest points to $$manifest_host (not $(BINDIR)/ap-browser-host)." >&2; \
			echo "      To update that target directly, run: make install BINDIR=\"$$(dirname "$$manifest_host")\"" >&2; \
		fi; \
	fi
	@if pgrep -x ap-browser-host >/dev/null 2>&1; then \
		echo "note: ap-browser-host is currently running; reload the extension in Chrome or restart the host so it picks up the new binary."; \
	fi
