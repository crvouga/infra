# .bao.yaml project config helpers (Doppler-style).
# shellcheck shell=bash

BAO_CONFIG_FILE=".bao.yaml"
BAO_DEFAULT_MOUNT="${BAO_DEFAULT_MOUNT:-doppler}"

read_bao_yaml_value() {
  local file="$1"
  local key="$2"
  grep -E "^${key}:[[:space:]]*" "$file" 2>/dev/null \
    | head -1 \
    | sed -E "s/^${key}:[[:space:]]*//" \
    | sed -E 's/^["'\''](.*)["'\'']$/\1/'
}

find_bao_config_file() {
  local dir="$PWD"
  local git_root=""

  while [ "$dir" != "/" ]; do
    if [ -f "${dir}/${BAO_CONFIG_FILE}" ]; then
      BAO_CONFIG_PATH="${dir}/${BAO_CONFIG_FILE}"
      return 0
    fi
    if [ -d "${dir}/.git" ]; then
      git_root="$dir"
      break
    fi
    dir="$(dirname "$dir")"
  done

  if [ -n "$git_root" ]; then
    dir="$git_root"
    while [ "$dir" != "/" ]; do
      if [ -f "${dir}/${BAO_CONFIG_FILE}" ]; then
        BAO_CONFIG_PATH="${dir}/${BAO_CONFIG_FILE}"
        return 0
      fi
      dir="$(dirname "$dir")"
    done
  fi

  return 1
}

load_bao_config_defaults() {
  BAO_CONFIG_ADDR=""
  BAO_CONFIG_MOUNT=""
  BAO_CONFIG_PROJECT=""
  BAO_CONFIG_CONFIG=""

  if ! find_bao_config_file; then
    return 1
  fi

  BAO_CONFIG_ADDR="$(read_bao_yaml_value "$BAO_CONFIG_PATH" addr)"
  BAO_CONFIG_MOUNT="$(read_bao_yaml_value "$BAO_CONFIG_PATH" mount)"
  BAO_CONFIG_PROJECT="$(read_bao_yaml_value "$BAO_CONFIG_PATH" project)"
  BAO_CONFIG_CONFIG="$(read_bao_yaml_value "$BAO_CONFIG_PATH" config)"
  return 0
}

resolve_secret_path() {
  local cli_mount="${1:-}"
  local cli_project="${2:-}"
  local cli_config="${3:-}"
  local cli_path="${4:-}"

  if [ -n "$cli_path" ]; then
    cli_path="${cli_path#/}"
    cli_path="${cli_path%/}"
    SECRET_PATH="$cli_path"
    return 0
  fi

  local mount project config
  mount="${cli_mount:-${BAO_MOUNT:-}}"
  project="${cli_project:-${BAO_PROJECT:-}}"
  config="${cli_config:-${BAO_CONFIG:-}}"

  if load_bao_config_defaults; then
    mount="${mount:-$BAO_CONFIG_MOUNT}"
    project="${project:-$BAO_CONFIG_PROJECT}"
    config="${config:-$BAO_CONFIG_CONFIG}"
    if [ -z "${BAO_ADDR:-}" ] && [ -n "$BAO_CONFIG_ADDR" ]; then
      BAO_ADDR="$BAO_CONFIG_ADDR"
    fi
  fi

  mount="${mount:-$BAO_DEFAULT_MOUNT}"
  mount="${mount#/}"
  mount="${mount%/}"

  if [ -z "$project" ] || [ -z "$config" ]; then
    echo "ERROR: Could not resolve secret path." >&2
    echo "" >&2
    echo "Provide --project and --config, set BAO_PROJECT/BAO_CONFIG," >&2
    echo "or run: bao setup --project <name> --config <name>" >&2
    return 1
  fi

  SECRET_PATH="${mount}/${project}/${config}"
  return 0
}

write_bao_config() {
  local addr="${1:-$BAO_DEFAULT_ADDR}"
  local mount="${2:-$BAO_DEFAULT_MOUNT}"
  local project="$3"
  local config="$4"
  local output="${5:-${BAO_CONFIG_FILE}}"

  if [ -z "$project" ] || [ -z "$config" ]; then
    echo "ERROR: --project and --config are required for setup." >&2
    return 1
  fi

  cat > "$output" <<EOF
addr: ${addr}
mount: ${mount}
project: ${project}
config: ${config}
EOF

  echo "Wrote ${output}:"
  cat "$output"
}
