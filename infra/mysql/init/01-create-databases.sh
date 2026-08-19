#!/bin/sh
# Order-To-Cash — MySQL bootstrap.
#
# Creates one database per service (database-per-service, no cross-database
# joins, no foreign keys crossing service boundaries — see CLAUDE.md) plus a
# dedicated database for n8n so its workflow tables never mix with ours, and
# grants the application user (MYSQL_USER) on all four.
#
# Why a .sh file and not a .sql file: docker-entrypoint-initdb.d executes
# .sql files literally through the mysql client with NO shell/env-var
# interpolation, which would force the username to be hardcoded here and
# silently drift from MYSQL_USER in .env if that ever changed (see
# progress/review defect D5). The MySQL entrypoint also runs .sh files placed
# in the same directory, with the full container environment available, so
# this script reads MYSQL_USER directly and cannot drift.
#
# Runs once, on first container init, because MySQL only executes
# /docker-entrypoint-initdb.d/* against an empty data directory.

set -eu

# Database names also come from the environment (MYSQL_DB_* in .env), rather
# than a second hardcoded copy, so they stay a single source of truth with
# whatever application services read from .env from phase 23 onwards.
DB_ORDERS="${MYSQL_DB_ORDERS:-otc_orders}"
DB_FULFILLMENT="${MYSQL_DB_FULFILLMENT:-otc_fulfillment}"
DB_BILLING="${MYSQL_DB_BILLING:-otc_billing}"
DB_N8N="${MYSQL_DB_N8N:-n8n}"

mysql -uroot -p"${MYSQL_ROOT_PASSWORD}" <<-SQL
	CREATE DATABASE IF NOT EXISTS \`${DB_ORDERS}\`      CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
	CREATE DATABASE IF NOT EXISTS \`${DB_FULFILLMENT}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
	CREATE DATABASE IF NOT EXISTS \`${DB_BILLING}\`     CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
	CREATE DATABASE IF NOT EXISTS \`${DB_N8N}\`         CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

	GRANT ALL PRIVILEGES ON \`${DB_ORDERS}\`.*      TO '${MYSQL_USER}'@'%';
	GRANT ALL PRIVILEGES ON \`${DB_FULFILLMENT}\`.* TO '${MYSQL_USER}'@'%';
	GRANT ALL PRIVILEGES ON \`${DB_BILLING}\`.*     TO '${MYSQL_USER}'@'%';
	GRANT ALL PRIVILEGES ON \`${DB_N8N}\`.*         TO '${MYSQL_USER}'@'%';

	FLUSH PRIVILEGES;
SQL
