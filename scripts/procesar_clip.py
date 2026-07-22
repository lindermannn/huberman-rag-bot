#!/usr/bin/env python3
"""Descarga, recorta a formato vertical y quema subtitulos progresivos de un clip aprobado.

Sincronizacion de subtitulos (de mejor a peor):
1. Alinear nuestra traduccion en español contra los subtitulos automaticos de
   YouTube en español (que traen timestamp real por palabra) usando difflib.
2. Si YouTube no tiene subtitulos en español para el video (raro): alinear los
   subtitulos automaticos de YouTube en ingles contra el transcript original en
   ingles (data/raw), y mapear esa posicion proporcionalmente sobre nuestro
   texto en español.
3. Si tampoco hay subtitulos en ingles (extremadamente raro): usar deteccion de
   silencios sobre el audio descargado como ultimo respaldo.
"""
import difflib
import json
import re
import subprocess
import sys
import time
from pathlib import Path

DURACION_CLIP_SEGUNDOS = 120
PALABRAS_POR_CAPTION = 5
PALABRAS_POR_SEGUNDO = 2.5
SILENCIO_DB = "-30dB"
SILENCIO_DURACION_MIN = 0.3
MIN_PROPORCION_ANCLAS = 0.2

ANCHO_FINAL = 1080
ALTO_FINAL = 1920

ROOT = Path(__file__).resolve().parent.parent
TRANSLATED_DIR = ROOT / "data" / "translated"
RAW_DIR = ROOT / "data" / "raw"
OUTPUT_DIR = ROOT / "data" / "clips_aprobados"


def parse_timestamp(ts: str) -> int:
    partes = [int(p) for p in ts.strip().split(":")]
    while len(partes) < 3:
        partes.insert(0, 0)
    horas, minutos, segundos = partes
    return horas * 3600 + minutos * 60 + segundos


def formatear_timestamp(segundos_totales: int) -> str:
    h = segundos_totales // 3600
    m = (segundos_totales % 3600) // 60
    s = segundos_totales % 60
    return f"{h:02d}:{m:02d}:{s:02d}"


def leer_transcript(id_podcast: str, base_dir: Path) -> str | None:
    transcript_path = base_dir / id_podcast / "transcript.md"
    if not transcript_path.exists():
        return None
    return transcript_path.read_text(encoding="utf-8")


def obtener_youtube_id(texto_transcript: str) -> str:
    match = re.search(r"^youtube_id:\s*(\S+)", texto_transcript, re.MULTILINE)
    if not match:
        raise ValueError("No se encontro youtube_id en el transcript")
    return match.group(1).strip()


def parsear_secciones(texto_transcript: str):
    patron = re.compile(r"^## \[(\d{2}):(\d{2}):(\d{2})\]\s*(.*)$", re.MULTILINE)
    coincidencias = list(patron.finditer(texto_transcript))
    secciones = []
    for i, m in enumerate(coincidencias):
        h, mnt, s = int(m.group(1)), int(m.group(2)), int(m.group(3))
        inicio = h * 3600 + mnt * 60 + s
        cuerpo_inicio = m.end()
        cuerpo_fin = coincidencias[i + 1].start() if i + 1 < len(coincidencias) else len(texto_transcript)
        cuerpo = texto_transcript[cuerpo_inicio:cuerpo_fin].strip()
        secciones.append((inicio, cuerpo))
    return secciones


def extraer_texto_clip(secciones, inicio: int, max_palabras: int) -> str:
    if not secciones:
        return ""

    idx_inicio = 0
    for i, (s_inicio, _) in enumerate(secciones):
        if s_inicio <= inicio:
            idx_inicio = i
        else:
            break

    palabras_acumuladas = []
    for i in range(idx_inicio, len(secciones)):
        s_inicio, s_cuerpo = secciones[i]
        s_fin = secciones[i + 1][0] if i + 1 < len(secciones) else s_inicio + 10**9
        s_cuerpo = re.sub(r"\*\*.*?:\*\*", "", s_cuerpo)  # quitar etiquetas de hablante en markdown
        palabras_seccion = re.sub(r"\s+", " ", s_cuerpo).strip().split(" ")

        if i == idx_inicio and s_fin > s_inicio:
            proporcion = max(0.0, min(1.0, (inicio - s_inicio) / (s_fin - s_inicio)))
            offset = int(len(palabras_seccion) * proporcion)
            palabras_seccion = palabras_seccion[offset:]

        palabras_acumuladas.extend(p for p in palabras_seccion if p)
        if len(palabras_acumuladas) >= max_palabras:
            break

    return " ".join(palabras_acumuladas[:max_palabras])


def normalizar_palabra(p: str) -> str:
    p = p.lower()
    p = re.sub(r"[^a-záéíóúñü]", "", p)
    return p.translate(str.maketrans("áéíóúü", "aeiouu"))


def obtener_subtitulos_youtube(youtube_id: str, idioma: str, prefijo_archivo: str,
                                inicio_ms: float, fin_ms: float, margen_ms: float = 20000,
                                intentos: int = 3, espera_reintento: float = 4.0):
    """Descarga los subtitulos automaticos de YouTube en el idioma dado.
    Devuelve una lista de (tiempo_ms, palabra) SOLO dentro de la ventana
    [inicio_ms - margen, fin_ms + margen], o None si no existen en ese idioma.
    Sin este filtro, difflib puede encontrar coincidencias de palabras comunes
    en cualquier parte del episodio completo (2+ horas), no solo en el clip.
    Reintenta con espera si YouTube responde con rate-limit (429), ya que la
    ruta directa en español es mas precisa que el respaldo en ingles y vale la
    pena insistir un poco antes de degradar la calidad."""
    plantilla_salida = OUTPUT_DIR / f"{prefijo_archivo}_subs_{idioma}"
    ruta_generada = OUTPUT_DIR / f"{prefijo_archivo}_subs_{idioma}.{idioma}.json3"
    comando = [
        "yt-dlp", "--skip-download",
        "--write-auto-subs", "--sub-langs", idioma, "--sub-format", "json3",
        "-o", str(plantilla_salida),
        f"https://www.youtube.com/watch?v={youtube_id}",
    ]

    for intento in range(1, intentos + 1):
        ruta_generada.unlink(missing_ok=True)
        resultado = subprocess.run(comando, capture_output=True, text=True)
        if ruta_generada.exists():
            break
        if "429" in resultado.stderr and intento < intentos:
            print(f"  Rate-limit de YouTube al pedir subtitulos {idioma} (intento {intento}/{intentos}), reintentando...")
            time.sleep(espera_reintento)
            continue
        break

    if not ruta_generada.exists():
        return None

    try:
        with open(ruta_generada, encoding="utf-8") as f:
            datos = json.load(f)
    except (json.JSONDecodeError, OSError):
        ruta_generada.unlink(missing_ok=True)
        return None

    ventana_inicio = inicio_ms - margen_ms
    ventana_fin = fin_ms + margen_ms

    palabras = []
    for evento in datos.get("events", []):
        t0 = evento.get("tStartMs", 0)
        if not (ventana_inicio <= t0 <= ventana_fin):
            continue
        for seg in evento.get("segs", []):
            texto = seg.get("utf8", "").strip()
            if texto:
                palabras.append((t0 + seg.get("tOffsetMs", 0), texto))

    ruta_generada.unlink(missing_ok=True)
    return palabras if palabras else None


def alinear_palabras(palabras_objetivo, palabras_referencia_con_tiempo):
    """Empareja palabras_objetivo (lista de strings) contra
    palabras_referencia_con_tiempo (lista de (tiempo_ms, texto)) usando
    coincidencia de secuencias. Devuelve lista de (indice_objetivo, tiempo_ms)."""
    norm_obj = [normalizar_palabra(p) for p in palabras_objetivo]
    norm_ref = [normalizar_palabra(p[1]) for p in palabras_referencia_con_tiempo]
    sm = difflib.SequenceMatcher(None, norm_obj, norm_ref, autojunk=False)
    anclas = []
    for bloque in sm.get_matching_blocks():
        for i in range(bloque.size):
            idx_obj = bloque.a + i
            idx_ref = bloque.b + i
            anclas.append((idx_obj, palabras_referencia_con_tiempo[idx_ref][0]))
    return anclas


def interpolar_tiempos(num_palabras: int, anclas, duracion_total_ms: float):
    """Devuelve una lista de tiempos (ms) de longitud num_palabras. Usa las
    anclas conocidas (indice, tiempo_ms) e interpola linealmente el resto."""
    if num_palabras == 0:
        return []

    tiempos = [None] * num_palabras
    for idx, t in anclas:
        if 0 <= idx < num_palabras:
            tiempos[idx] = t

    indices_con_ancla = [i for i in range(num_palabras) if tiempos[i] is not None]
    if not indices_con_ancla:
        return [i * duracion_total_ms / num_palabras for i in range(num_palabras)]

    primero, ultimo = indices_con_ancla[0], indices_con_ancla[-1]
    if tiempos[0] is None:
        tiempos[0] = max(0.0, tiempos[primero] - primero * 300)
    if tiempos[-1] is None:
        tiempos[-1] = tiempos[ultimo]

    i = 0
    while i < num_palabras:
        if tiempos[i] is not None:
            i += 1
            continue
        j = i
        while j < num_palabras and tiempos[j] is None:
            j += 1
        t_izq, t_der = tiempos[i - 1], tiempos[j]
        paso = (t_der - t_izq) / (j - i + 1)
        for k in range(i, j):
            tiempos[k] = t_izq + paso * (k - i + 1)
        i = j

    return tiempos


def recortar_cola_fuera_de_rango(palabras, tiempos_abs, inicio_ms: float, duracion_ms: float):
    """Corta las palabras finales cuyo tiempo estimado cae fuera de la duracion
    real del clip (en vez de apilarlas todas al final). Devuelve
    (palabras_recortadas, tiempos_relativos_seg)."""
    limite = inicio_ms + duracion_ms * 1.02
    corte = len(palabras)
    for i, t in enumerate(tiempos_abs):
        if t > limite:
            corte = i
            break
    palabras_recortadas = palabras[:max(1, corte)]
    tiempos_rel = [
        max(0.0, min(duracion_ms / 1000, (t - inicio_ms) / 1000))
        for t in tiempos_abs[:max(1, corte)]
    ]
    return palabras_recortadas, tiempos_rel


def construir_timing_alineado(id_podcast: str, youtube_id: str, inicio_segundos: int,
                               texto_clip_es: str, prefijo_archivo: str):
    """Intenta construir (palabras, tiempos_relativos_seg) alineando con
    subtitulos reales de YouTube. Devuelve None si no fue posible."""
    palabras_es = [p for p in texto_clip_es.split(" ") if p]
    if not palabras_es:
        return None

    duracion_ms = DURACION_CLIP_SEGUNDOS * 1000
    inicio_ms_ventana = inicio_segundos * 1000
    fin_ms_ventana = inicio_ms_ventana + duracion_ms

    # Intento 1: subtitulos de YouTube en español, alineados directo contra nuestro texto
    palabras_ref_es = obtener_subtitulos_youtube(youtube_id, "es", prefijo_archivo, inicio_ms_ventana, fin_ms_ventana)
    if palabras_ref_es:
        anclas = alinear_palabras(palabras_es, palabras_ref_es)
        if len(anclas) >= max(3, len(palabras_es) * MIN_PROPORCION_ANCLAS):
            inicio_ms = inicio_segundos * 1000
            tiempos_abs = interpolar_tiempos(len(palabras_es), anclas, duracion_ms)
            palabras_finales, tiempos_rel = recortar_cola_fuera_de_rango(palabras_es, tiempos_abs, inicio_ms, duracion_ms)
            print(f"Sincronizado con subtitulos ES de YouTube ({len(anclas)}/{len(palabras_es)} palabras ancladas)")
            return palabras_finales, tiempos_rel

    # Intento 2 (raro): subtitulos en ingles alineados contra el transcript original,
    # mapeando esa posicion proporcionalmente sobre nuestro texto en español
    palabras_ref_en = obtener_subtitulos_youtube(youtube_id, "en", prefijo_archivo, inicio_ms_ventana, fin_ms_ventana)
    if palabras_ref_en:
        texto_transcript_en = leer_transcript(id_podcast, RAW_DIR)
        if texto_transcript_en:
            secciones_en = parsear_secciones(texto_transcript_en)
            # Buffer moderado (1.4x): suficiente margen por diferencias de longitud
            # ES/EN sin pasarse tanto del contenido real de 120s (eso causaba que el
            # sobrante se apilara todo al final del clip).
            texto_clip_en = extraer_texto_clip(secciones_en, inicio_segundos, max(50, int(len(palabras_es) * 1.4)))
            palabras_en = [p for p in texto_clip_en.split(" ") if p]
            if palabras_en:
                anclas_en = alinear_palabras(palabras_en, palabras_ref_en)
                if len(anclas_en) >= max(3, len(palabras_en) * MIN_PROPORCION_ANCLAS):
                    inicio_ms = inicio_segundos * 1000
                    tiempos_en_abs = interpolar_tiempos(len(palabras_en), anclas_en, duracion_ms)
                    anclas_es = []
                    for idx_en, t in enumerate(tiempos_en_abs):
                        proporcion = idx_en / max(1, len(palabras_en) - 1)
                        idx_es = round(proporcion * (len(palabras_es) - 1))
                        anclas_es.append((idx_es, t))
                    tiempos_abs = interpolar_tiempos(len(palabras_es), anclas_es, duracion_ms)
                    palabras_finales, tiempos_rel = recortar_cola_fuera_de_rango(palabras_es, tiempos_abs, inicio_ms, duracion_ms)
                    print(f"Sincronizado con subtitulos EN de YouTube mapeados a español "
                          f"({len(anclas_en)}/{len(palabras_en)} palabras EN ancladas)")
                    return palabras_finales, tiempos_rel

    return None


def construir_caption_chunks_con_tiempo(palabras, tiempos_rel):
    """Agrupa palabras+tiempos en chunks de PALABRAS_POR_CAPTION, usando el
    tiempo de la primera palabra de cada chunk como inicio."""
    chunks = []
    for i in range(0, len(palabras), PALABRAS_POR_CAPTION):
        grupo_palabras = palabras[i:i + PALABRAS_POR_CAPTION]
        texto = " ".join(grupo_palabras).upper()
        t_inicio = tiempos_rel[i]
        chunks.append((texto, t_inicio))
    return chunks


def construir_caption_chunks(texto: str):
    """Sin timing real: solo agrupa palabras en chunks (se reparten con
    deteccion de silencios como respaldo)."""
    palabras = [p for p in texto.split(" ") if p]
    chunks = []
    for i in range(0, len(palabras), PALABRAS_POR_CAPTION):
        chunk = " ".join(palabras[i:i + PALABRAS_POR_CAPTION]).upper()
        if chunk:
            chunks.append(chunk)
    return chunks


def detectar_segmentos_de_habla(ruta_video: Path, duracion_total: float):
    """Ultimo respaldo si no hay subtitulos de YouTube disponibles."""
    comando = [
        "ffmpeg", "-i", str(ruta_video),
        "-af", f"silencedetect=noise={SILENCIO_DB}:d={SILENCIO_DURACION_MIN}",
        "-f", "null", "-",
    ]
    resultado = subprocess.run(comando, capture_output=True, text=True)

    silencios = []
    inicio_silencio = None
    for linea in resultado.stderr.splitlines():
        m_inicio = re.search(r"silence_start:\s*([\d.]+)", linea)
        if m_inicio:
            inicio_silencio = float(m_inicio.group(1))
            continue
        m_fin = re.search(r"silence_end:\s*([\d.]+)", linea)
        if m_fin and inicio_silencio is not None:
            silencios.append((inicio_silencio, float(m_fin.group(1))))
            inicio_silencio = None

    silencios.sort()
    segmentos = []
    cursor = 0.0
    for s_inicio, s_fin in silencios:
        if s_inicio > cursor:
            segmentos.append((cursor, s_inicio))
        cursor = max(cursor, s_fin)
    if cursor < duracion_total:
        segmentos.append((cursor, duracion_total))

    segmentos = [(a, b) for a, b in segmentos if b - a > 0.05]
    if not segmentos:
        segmentos = [(0.0, duracion_total)]
    return segmentos


def mapear_tiempo_habla_a_real(t_habla: float, segmentos) -> float:
    acumulado = 0.0
    for s_inicio, s_fin in segmentos:
        dur = s_fin - s_inicio
        if t_habla <= acumulado + dur:
            return s_inicio + (t_habla - acumulado)
        acumulado += dur
    return segmentos[-1][1]


def escapar_ass(texto: str) -> str:
    return texto.replace("\\", "\\\\").replace("{", "(").replace("}", ")").replace("\n", "\\N")


def formatear_tiempo_ass(segundos: float) -> str:
    h = int(segundos // 3600)
    m = int((segundos % 3600) // 60)
    s = segundos % 60
    return f"{h:d}:{m:02d}:{s:05.2f}"


ESTILOS_ASS = [
    "[Script Info]",
    "ScriptType: v4.00+",
    f"PlayResX: {ANCHO_FINAL}",
    f"PlayResY: {ALTO_FINAL}",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
    "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
    "Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Caption,DejaVu Sans,66,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,5,0,5,60,60,500,1",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
]


def generar_ass_con_timing_real(chunks_con_tiempo, duracion_total: float, ruta_ass: Path) -> None:
    lineas = list(ESTILOS_ASS)
    for i, (texto, t_inicio) in enumerate(chunks_con_tiempo):
        t_fin = chunks_con_tiempo[i + 1][1] if i + 1 < len(chunks_con_tiempo) else duracion_total
        t_inicio = max(0.0, min(t_inicio, duracion_total))
        t_fin = max(t_inicio + 0.3, min(t_fin, duracion_total))
        lineas.append(
            f"Dialogue: 0,{formatear_tiempo_ass(t_inicio)},{formatear_tiempo_ass(t_fin)},Caption,,0,0,0,,{escapar_ass(texto)}"
        )
    ruta_ass.write_text("\n".join(lineas), encoding="utf-8")


def generar_ass_con_silencios(caption_chunks, segmentos_habla, duracion_total: float, ruta_ass: Path) -> None:
    lineas = list(ESTILOS_ASS)
    if caption_chunks:
        total_habla = sum(fin - inicio for inicio, fin in segmentos_habla)
        dur_habla_por_chunk = total_habla / len(caption_chunks)
        for i, chunk in enumerate(caption_chunks):
            t0_habla = i * dur_habla_por_chunk
            t1_habla = (i + 1) * dur_habla_por_chunk
            t0 = mapear_tiempo_habla_a_real(t0_habla, segmentos_habla)
            t1 = mapear_tiempo_habla_a_real(t1_habla, segmentos_habla)
            if t1 <= t0:
                t1 = min(duracion_total, t0 + 0.5)
            lineas.append(
                f"Dialogue: 0,{formatear_tiempo_ass(t0)},{formatear_tiempo_ass(t1)},Caption,,0,0,0,,{escapar_ass(chunk)}"
            )
    ruta_ass.write_text("\n".join(lineas), encoding="utf-8")


def main() -> int:
    if len(sys.argv) < 3:
        print("Uso: procesar_clip.py <id_podcast> <timestamp_inicio HH:MM:SS>", file=sys.stderr)
        return 1

    id_podcast = sys.argv[1]
    timestamp_inicio = sys.argv[2]
    # El hook (sys.argv[3], si viene) ya no se quema en el video: se usa solo
    # como texto para la publicacion/caption, no como overlay.

    inicio_segundos = parse_timestamp(timestamp_inicio)
    fin_segundos = inicio_segundos + DURACION_CLIP_SEGUNDOS
    inicio_fmt = formatear_timestamp(inicio_segundos)
    fin_fmt = formatear_timestamp(fin_segundos)

    texto_transcript_es = leer_transcript(id_podcast, TRANSLATED_DIR)
    if not texto_transcript_es:
        print(f"No existe transcript traducido para {id_podcast}", file=sys.stderr)
        return 1
    youtube_id = obtener_youtube_id(texto_transcript_es)
    url = f"https://www.youtube.com/watch?v={youtube_id}"

    secciones_es = parsear_secciones(texto_transcript_es)
    max_palabras = max(1, int(PALABRAS_POR_SEGUNDO * DURACION_CLIP_SEGUNDOS))
    texto_clip_es = extraer_texto_clip(secciones_es, inicio_segundos, max_palabras)

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    nombre_archivo = f"{id_podcast}_{timestamp_inicio.replace(':', '')}"
    ruta_raw = OUTPUT_DIR / f"{nombre_archivo}_raw.%(ext)s"
    ruta_raw_mp4 = OUTPUT_DIR / f"{nombre_archivo}_raw.mp4"
    ruta_ass = OUTPUT_DIR / f"{nombre_archivo}.ass"
    ruta_final = OUTPUT_DIR / f"{nombre_archivo}_reel.mp4"

    print("Buscando sincronizacion real con subtitulos de YouTube...")
    resultado_alineacion = construir_timing_alineado(id_podcast, youtube_id, inicio_segundos, texto_clip_es, nombre_archivo)

    comando_descarga = [
        "yt-dlp",
        url,
        "--download-sections", f"*{inicio_fmt}-{fin_fmt}",
        "--force-keyframes-at-cuts",
        "-f", "bv*[height<=1080]+ba/b[height<=1080]",
        "--merge-output-format", "mp4",
        "-o", str(ruta_raw),
    ]

    print(f"Descargando clip de {id_podcast} ({inicio_fmt} - {fin_fmt}) desde {url}")
    resultado = subprocess.run(comando_descarga, capture_output=True, text=True)
    if resultado.returncode != 0:
        print(resultado.stdout)
        print(resultado.stderr, file=sys.stderr)
        return resultado.returncode
    print(resultado.stdout)

    if resultado_alineacion:
        palabras, tiempos_rel = resultado_alineacion
        chunks_con_tiempo = construir_caption_chunks_con_tiempo(palabras, tiempos_rel)
        generar_ass_con_timing_real(chunks_con_tiempo, float(DURACION_CLIP_SEGUNDOS), ruta_ass)
        print(f"Subtitulos generados con timing real: {len(chunks_con_tiempo)} caption(s) -> {ruta_ass}")
    else:
        print("No se pudo sincronizar con subtitulos de YouTube, usando deteccion de silencios como respaldo...")
        caption_chunks = construir_caption_chunks(texto_clip_es)
        segmentos_habla = detectar_segmentos_de_habla(ruta_raw_mp4, float(DURACION_CLIP_SEGUNDOS))
        print(f"{len(segmentos_habla)} segmento(s) de habla detectado(s)")
        generar_ass_con_silencios(caption_chunks, segmentos_habla, DURACION_CLIP_SEGUNDOS, ruta_ass)
        print(f"Subtitulos generados: {len(caption_chunks)} caption(s) -> {ruta_ass}")

    filtro = (
        f"crop=ih*{ANCHO_FINAL}/{ALTO_FINAL}:ih,"
        f"scale={ANCHO_FINAL}:{ALTO_FINAL},"
        f"ass={ruta_ass}"
    )
    comando_ffmpeg = [
        "ffmpeg", "-y",
        "-i", str(ruta_raw_mp4),
        "-vf", filtro,
        "-c:v", "libx264", "-crf", "20", "-preset", "veryfast",
        "-c:a", "aac", "-b:a", "128k",
        str(ruta_final),
    ]

    print("Recortando a formato vertical y quemando subtitulos...")
    resultado_ffmpeg = subprocess.run(comando_ffmpeg, capture_output=True, text=True)
    if resultado_ffmpeg.returncode != 0:
        print(resultado_ffmpeg.stdout)
        print(resultado_ffmpeg.stderr, file=sys.stderr)
        return resultado_ffmpeg.returncode

    ruta_raw_mp4.unlink(missing_ok=True)
    ruta_ass.unlink(missing_ok=True)

    print(f"Reel final guardado en: {ruta_final}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
