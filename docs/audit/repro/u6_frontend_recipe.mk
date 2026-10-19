SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c
frontend:
	@cd "/tmp" && \
	false && \
	trap 'echo TRAP-RAN' EXIT; \
	echo "STARTED astro dev in $$PWD (trap set? $$(trap -p EXIT))"; \
	echo "logs --follow"
