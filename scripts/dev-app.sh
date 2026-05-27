#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_DIR="$ROOT_DIR"
MODE="${1:-preview}"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-1420}"

log() {
  printf '[apkworkshop] %s\n' "$*"
}

has_cmd() {
  command -v "$1" >/dev/null 2>&1
}

require_cmd() {
  if ! has_cmd "$1"; then
    log "缺少命令: $1"
    return 1
  fi
}

ensure_node_modules() {
  if [ ! -d "$APP_DIR/node_modules" ]; then
    log "未发现 node_modules，开始安装前端依赖..."
    (cd "$APP_DIR" && npm install)
  fi
}

show_env() {
  log "项目目录: $ROOT_DIR"
  log "App目录: $APP_DIR"
  log "模式: $MODE"
}

run_preview() {
  require_cmd npm
  ensure_node_modules
  log "先执行前端构建校验..."
  (cd "$APP_DIR" && npm run build)
  log "启动 Vite 预览，访问: http://$HOST:$PORT"
  exec bash -lc "cd \"$APP_DIR\" && npm run preview -- --host $HOST --port $PORT"
}

run_frontend_dev() {
  require_cmd npm
  ensure_node_modules
  log "启动前端开发服务器，访问: http://$HOST:$PORT"
  exec bash -lc "cd \"$APP_DIR\" && npm run dev -- --host $HOST --port $PORT"
}

run_tauri_dev() {
  require_cmd npm
  require_cmd cargo
  require_cmd rustc
  ensure_node_modules
  log "启动 Tauri 桌面开发模式..."
  exec bash -lc "cd \"$APP_DIR\" && npm run tauri:dev"
}

run_tauri_build() {
  require_cmd npm
  require_cmd cargo
  require_cmd rustc
  ensure_node_modules
  log "开始构建桌面应用..."
  (cd "$APP_DIR" && npm run tauri:build)
  log "构建完成，产物目录:"
  if [ -d "$APP_DIR/src-tauri/target/release/bundle" ]; then
    find "$APP_DIR/src-tauri/target/release/bundle" -maxdepth 3 -type f | sed 's#^#  - #'
  else
    log "未发现 bundle 目录，请检查 Tauri 构建输出。"
  fi
}

usage() {
  cat <<EOF
APK Workshop 一键脚本

用法:
  ./scripts/dev-app.sh preview      # 默认；前端构建并启动预览
  ./scripts/dev-app.sh dev          # 启动前端开发服务器
  ./scripts/dev-app.sh tauri-dev    # 启动 Tauri 桌面开发模式
  ./scripts/dev-app.sh tauri-build  # 构建桌面应用安装包/产物

可选环境变量:
  HOST=127.0.0.1
  PORT=1420
EOF
}

show_env

case "$MODE" in
  preview)
    run_preview
    ;;
  dev)
    run_frontend_dev
    ;;
  tauri-dev)
    run_tauri_dev
    ;;
  tauri-build)
    run_tauri_build
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    log "未知模式: $MODE"
    usage
    exit 1
    ;;
esac
