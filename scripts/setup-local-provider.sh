#!/usr/bin/env bash
#
# Descarga e instala, FUERA de este repositorio y de git, los 3 procesos
# externos que necesita PROVIDER=local: whisper.cpp (STT), LibreTranslate
# (traduccion) y Piper (voz). Ninguno de los tres se incorpora al repo:
# whisper.cpp hay que compilarlo para tu plataforma, LibreTranslate es un
# servicio Python (no un binario), y los modelos pesan demasiado para git
# normal y tienen sus propias licencias de redistribucion - ver "Proveedor
# local" en SPEC.md para el detalle completo de por que se hace asi.
#
# Todo lo descargado queda en ./local-provider/ (ignorado por git).
#
# Uso:
#   scripts/setup-local-provider.sh [--skip-stt] [--skip-translate] [--skip-tts]
#
# Variables de entorno opcionales para ajustar que se descarga:
#   WHISPER_MODEL   Modelo de whisper.cpp (tiny|base|small|medium|large-v3...).
#                   Default: base (~140MB, balance razonable de velocidad/calidad).
#   LT_LANGUAGES    Pares de idioma a precargar en LibreTranslate (formato
#                   propio de --load-only: "es,en,fr"). Default cubre los
#                   idiomas de LANGUAGES en src/config.ts que SI tienen una
#                   voz de Piper conocida por este script (ver PIPER_VOICES).
#   PIPER_VOICES    Lista "voiceId:languageId,..." a descargar desde el
#                   repositorio de Hugging Face rhasspy/piper-voices. El
#                   default cubre es-ES/en-US/en-GB/fr-FR/de-DE/it-IT/pt-BR -
#                   deliberadamente NO incluye es-US/ja-JP/zh-CN porque no
#                   hay certeza de que exista una voz oficial de Piper con
#                   ese nombre exacto; busca la tuya en
#                   https://huggingface.co/rhasspy/piper-voices y agregala
#                   con este formato si la necesitas.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
DEST_DIR="$REPO_ROOT/local-provider"

WHISPER_MODEL="${WHISPER_MODEL:-base}"
LT_LANGUAGES="${LT_LANGUAGES:-es,en,fr,de,it,pt}"
PIPER_VOICES="${PIPER_VOICES:-es_ES-davefx-medium:es-ES,en_US-lessac-medium:en-US,en_GB-alan-medium:en-GB,fr_FR-siwis-medium:fr-FR,de_DE-thorsten-medium:de-DE,it_IT-paola-medium:it-IT,pt_BR-faber-medium:pt-BR}"

SKIP_STT=false
SKIP_TRANSLATE=false
SKIP_TTS=false
for arg in "$@"; do
  case "$arg" in
    --skip-stt) SKIP_STT=true ;;
    --skip-translate) SKIP_TRANSLATE=true ;;
    --skip-tts) SKIP_TTS=true ;;
    *) echo "Argumento desconocido: $arg" >&2; exit 1 ;;
  esac
done

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Falta '$1' en el PATH. Instalalo antes de continuar." >&2
    exit 1
  fi
}

mkdir -p "$DEST_DIR"
echo "==> Instalando el proveedor local en: $DEST_DIR"
echo

# --- 1. whisper.cpp (STT) ---
if [ "$SKIP_STT" = true ]; then
  echo "==> [1/3] STT (whisper.cpp): omitido (--skip-stt)"
else
  echo "==> [1/3] STT: whisper.cpp"
  require_cmd git
  require_cmd cmake

  WHISPER_DIR="$DEST_DIR/whisper.cpp"
  if [ ! -d "$WHISPER_DIR" ]; then
    git clone --depth 1 https://github.com/ggerganov/whisper.cpp.git "$WHISPER_DIR"
  else
    echo "    (ya clonado, no se actualiza - borra $WHISPER_DIR para reclonar)"
  fi

  echo "    Compilando (puede tardar varios minutos)..."
  cmake -S "$WHISPER_DIR" -B "$WHISPER_DIR/build" -DCMAKE_BUILD_TYPE=Release >/dev/null
  JOBS="$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 2)"
  cmake --build "$WHISPER_DIR/build" --config Release -j"$JOBS"

  SERVER_BIN="$(find "$WHISPER_DIR/build" -type f \( -name 'whisper-server' -o -name 'whisper-server.exe' \) | head -n1)"
  if [ -z "$SERVER_BIN" ]; then
    echo "    AVISO: no encontre el binario whisper-server tras compilar - revisa la salida de cmake arriba." >&2
  else
    echo "    Binario: $SERVER_BIN"
  fi

  echo "    Descargando el modelo '$WHISPER_MODEL' (ggml-$WHISPER_MODEL.bin)..."
  bash "$WHISPER_DIR/models/download-ggml-model.sh" "$WHISPER_MODEL" "$WHISPER_DIR/models"
  echo "    Listo."
fi
echo

# --- 2. LibreTranslate (traduccion) ---
if [ "$SKIP_TRANSLATE" = true ]; then
  echo "==> [2/3] Traduccion (LibreTranslate): omitido (--skip-translate)"
else
  echo "==> [2/3] Traduccion: LibreTranslate"
  require_cmd python3

  LT_VENV="$DEST_DIR/libretranslate-venv"
  if [ ! -d "$LT_VENV" ]; then
    python3 -m venv "$LT_VENV"
  fi
  # shellcheck disable=SC1091
  source "$LT_VENV/bin/activate"
  pip install --quiet --upgrade pip
  pip install --quiet libretranslate
  deactivate
  echo "    Instalado en $LT_VENV (venv propio, no toca tu Python del sistema)."
fi
echo

# --- 3. Piper (voz) ---
if [ "$SKIP_TTS" = true ]; then
  echo "==> [3/3] Voz (Piper): omitido (--skip-tts)"
else
  echo "==> [3/3] Voz: Piper"
  require_cmd python3
  require_cmd curl

  PIPER_VENV="$DEST_DIR/piper-venv"
  if [ ! -d "$PIPER_VENV" ]; then
    python3 -m venv "$PIPER_VENV"
  fi
  # shellcheck disable=SC1091
  source "$PIPER_VENV/bin/activate"
  pip install --quiet --upgrade pip
  pip install --quiet piper-tts
  deactivate
  echo "    Piper instalado en $PIPER_VENV."

  VOICES_DIR="$DEST_DIR/piper-voices"
  mkdir -p "$VOICES_DIR"
  echo "    Descargando voces desde huggingface.co/rhasspy/piper-voices..."

  IFS=',' read -ra VOICE_PAIRS <<< "$PIPER_VOICES"
  for pair in "${VOICE_PAIRS[@]}"; do
    voice_id="${pair%%:*}"   # ej. es_ES-davefx-medium
    language_id="${pair##*:}" # ej. es-ES (debe coincidir con LANGUAGES en src/config.ts)

    locale="${voice_id%%-*}"        # es_ES
    rest="${voice_id#*-}"           # davefx-medium
    quality="${rest##*-}"           # medium
    name="${rest%-*}"               # davefx
    lang="${locale%%_*}"            # es

    url_dir="https://huggingface.co/rhasspy/piper-voices/resolve/main/${lang}/${locale}/${name}/${quality}"
    onnx_dest="$VOICES_DIR/${language_id}.onnx"
    json_dest="$VOICES_DIR/${language_id}.onnx.json"

    echo "    - ${language_id} <- ${voice_id}"
    if curl -fsSL -o "$onnx_dest" "${url_dir}/${voice_id}.onnx" && \
       curl -fsSL -o "$json_dest" "${url_dir}/${voice_id}.onnx.json"; then
      echo "      OK"
    else
      echo "      FALLO - revisa el nombre de voz en https://huggingface.co/rhasspy/piper-voices y reintenta con PIPER_VOICES=\"${voice_id}:${language_id}\"" >&2
      rm -f "$onnx_dest" "$json_dest"
    fi
  done
fi

echo
echo "=================================================================="
echo "Listo. Para usar PROVIDER=local, corre estos 3 procesos ANTES de"
echo "iniciar la app (cada uno en su propia terminal), y deja esta config"
echo "en tu .env:"
echo
echo "  PROVIDER=local"
echo "  LOCAL_STT_URL=http://127.0.0.1:8178"
echo "  LOCAL_TRANSLATE_URL=http://127.0.0.1:5000"
echo "  PIPER_BINARY_PATH=$DEST_DIR/piper-venv/bin/piper"
echo "  PIPER_MODEL_DIR=$DEST_DIR/piper-voices"
echo
echo "1) STT:"
echo "   $DEST_DIR/whisper.cpp/build/bin/whisper-server \\"
echo "     -m $DEST_DIR/whisper.cpp/models/ggml-$WHISPER_MODEL.bin --port 8178"
echo
echo "2) Traduccion:"
echo "   source $DEST_DIR/libretranslate-venv/bin/activate"
echo "   libretranslate --port 5000 --load-only $LT_LANGUAGES"
echo
echo "3) Voz: no necesita un proceso aparte - 'piper' se invoca por frase"
echo "   (ya configurado arriba via PIPER_BINARY_PATH/PIPER_MODEL_DIR)."
echo "=================================================================="
