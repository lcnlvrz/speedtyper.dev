# backend

install-backend-dependencies:
	yarn --cwd ./packages/back-nest

run-backend-dev:
	yarn --cwd ./packages/back-nest start:dev

run-dev-db:
	docker compose -f ./packages/back-nest/docker-compose.yml up -d

run-dev:
	npm i -g concurrently
	concurrently "cd ./packages/back-nest && npm run start:dev" "cd ./packages/webapp-next && npm run dev"

run-seed-codesources:
	cd ./packages/back-nest && npm run command seed-challenges

install-webapp-dependencies:
	yarn --cwd ./packages/webapp-next

run-webapp-dev:
	yarn --cwd ./packages/webapp-next dev
