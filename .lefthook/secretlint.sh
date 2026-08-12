#!/usr/bin/env bash
# staged ファイルの秘密情報スキャン（lefthook pre-commit から呼ばれる）
# fail-secure: secretlint が無い・設定が無い場合はコミットを拒否する

set -euo pipefail

# pnpm global にインストールした secretlint を PATH に追加（既存グローバル hook と同様）
PNPM_HOME="${PNPM_HOME:-$HOME/.local/share/pnpm}"
if [[ -d "$PNPM_HOME" ]]; then
  case ":$PATH:" in
    *":$PNPM_HOME:"*) ;;
    *) export PATH="$PNPM_HOME:$PATH" ;;
  esac
fi

if ! command -v secretlint >/dev/null 2>&1; then
  echo "[pre-commit] secretlint not installed — rejecting commit for safety." >&2
  exit 1
fi

# プロジェクト .secretlintrc 優先、無ければグローバル設定を明示
CONFIG=""
for candidate in .secretlintrc.json .secretlintrc.yaml .secretlintrc.yml .secretlintrc.js .secretlintrc; do
  if [[ -f "$candidate" ]]; then
    CONFIG="$candidate"
    break
  fi
done

if [[ -z "$CONFIG" ]]; then
  GLOBAL_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/secretlint/.secretlintrc.json"
  if [[ ! -f "$GLOBAL_CONFIG" ]]; then
    echo "[pre-commit] no project .secretlintrc and global config missing: $GLOBAL_CONFIG" >&2
    exit 1
  fi
  exec secretlint --secretlintrc "$GLOBAL_CONFIG" "$@"
fi

exec secretlint "$@"
