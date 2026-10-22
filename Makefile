SHELL := /bin/bash
.DEFAULT_GOAL := help

NAME ?= DarkNext3000
SHARD ?= steam
MATCHES ?= 20
REGION ?= us-east1
export REGION

.PHONY: help local live login url setup dev api web crawler crawl status stop typecheck test build gcloud-login deploy

help:
	@echo "PUBGSTATS"
	@echo "  make local    Run crawler + API + web locally"
	@echo "  make live     Deploy/update the production VM"
	@echo "  make login    Authenticate the Google Cloud CLI"
	@echo "  make url      Print the live site URL"
	@echo "  make crawl    Crawl one player locally"
	@echo "  make status   Local database/crawler status"
	@echo "  make test     Run the test suite"
	@echo "  make build    Build the web app"

local: dev
live: deploy
login: gcloud-login

url:
	@IP=$$(./scripts/gcloud.sh compute addresses describe pubgstats-ip --region=$(REGION) --format='value(address)' 2>/dev/null || true); \
	if [ -n "$$IP" ]; then echo "https://$${IP//./-}.sslip.io"; else echo "No deployed IP found. Run 'make live' first."; fi

setup:
	./scripts/bootstrap.sh
	./scripts/with-node.sh npm install
	@echo "Done. Copy .env.example to .env, add PUBG_API_KEY, then run 'make crawl' and 'make local'."

dev:
	./scripts/dev.sh

api:
	./scripts/with-node.sh npm run dev --workspace @pubgstats/api

web:
	./scripts/with-node.sh npm run dev --workspace @pubgstats/web

crawler:
	./scripts/with-node.sh npm run dev --workspace @pubgstats/crawler

crawl:
	./scripts/crawl.sh "$(NAME)" "$(SHARD)" "$(MATCHES)"

gcloud-login:
	./scripts/gcloud-login.sh

deploy:
	./deploy/vm/deploy.sh

status:
	./scripts/crawler.sh status

stop:
	@if [ -f data/crawler.pid ]; then kill "$$(cat data/crawler.pid)" 2>/dev/null || true; rm -f data/crawler.pid; echo "Crawler stopped."; else echo "No crawler pid file."; fi

typecheck:
	./scripts/with-node.sh npx tsc -p apps/crawler/tsconfig.json --noEmit
	./scripts/with-node.sh npx tsc -p apps/api/tsconfig.json --noEmit
	./scripts/with-node.sh npx tsc -p apps/web/tsconfig.json --noEmit

test:
	./scripts/with-node.sh npx vitest run

build:
	./scripts/with-node.sh npm run build --workspace @pubgstats/web
