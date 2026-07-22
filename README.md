# Bot de Huberman — Sistema RAG

Bot de coaching conversacional (Telegram) basado en el contenido del podcast [Huberman Lab](https://www.hubermanlab.com/), construido como pieza de portafolio para demostrar diseño e implementación de un sistema RAG (Retrieval-Augmented Generation) de nivel producción: ingesta, recuperación híbrida, reranking, evaluación cuantitativa y debugging real en producción.

No es un wrapper de un LLM con un prompt largo. Es un pipeline de recuperación con evaluación medible, iterado en base a datos, corriendo sobre infraestructura multi-tenant compartida (n8n Cloud + Supabase/pgvector).

## Arquitectura

### 1. Ingesta (offline, un solo run)

```
transcripts/resúmenes de episodios (data/raw/EP-XXX/)
  → normalización a filas KB (id, topic, text, episode_number, episode_date)
  → embeddings (OpenAI text-embedding-3-small, batches de 100)
  → upsert a Supabase (kb_documents, pgvector), idempotente por id
```

Script: [`src/migrate_to_supabase.js`](src/migrate_to_supabase.js). Corre 100% local (Node nativo, sin dependencias) — la migración vía n8n Cloud se abandonó tras crashes de OOM reproducibles independientes del tamaño del batch (9355/1000/200 filas crasheaban igual); moverla fuera de la plataforma de orquestación fue la decisión correcta. Resultado: **9,355 filas** indexadas.

**Fase 3 — segunda capa de ingesta, chunking por timestamp real:** [`src/build_transcript_chunks.js`](src/build_transcript_chunks.js) parsea los transcripts traducidos y corta un chunk por sección usando los marcadores de capítulo reales del propio podcast (`## [hh:mm:ss] Título`), con sub-split por oración para secciones >3000 chars y de-duplicación de IDs. Resultado: **17,899 chunks adicionales** (379/413 episodios) con `timestamp_start`/`timestamp_end` reales, subidos de forma aditiva por [`src/migrate_transcript_chunks_to_supabase.js`](src/migrate_transcript_chunks_to_supabase.js) — la KB pasó de 9,355 a ~27,254 filas sin tocar las existentes (reversible con un `DELETE WHERE topic='transcript_segment'`).

### 2. Recuperación (online, por mensaje)

```
mensaje del usuario
  → Query Rewriting (LLM reescribe preguntas vagas/coloquiales a keywords de búsqueda concretas)
  → embedding de la query reescrita
  → Hybrid Search en Supabase (match_kb_documents_hybrid):
        similitud vectorial (coseno, pgvector)  ⊕  full-text search Postgres (BM25-like, content_tsv/websearch_to_tsquery)
        fusionados con Reciprocal Rank Fusion (RRF, k=50)
  → LLM Rerank (reordena los top-K candidatos por relevancia real a la pregunta)
  → construcción de respuesta con cita:
        [Episodio N]                              (filas de resumen, sin timestamp)
        [Episodio N | hh:mm:ss → youtu.be/ID?t=s]  (chunks de transcript: deep-link
                                                    de YouTube al minuto exacto)
```

Desde 2026-07-21 corre en un **workflow único y autocontenido** (ver Caso de estudio 4) — sin agente con tool-calling, sin dependencia de ninguna infraestructura multi-tenant compartida. El retrieval es incondicional y determinístico: no hay una decisión de "¿llamo al RAG o no?" de la que un LLM se pueda saltear.

## Por qué hybrid + rewriting + rerank, y no solo vector search

Búsqueda vectorial pura falla en dos casos comunes en este dominio: (a) preguntas con términos técnicos exactos (dosis, nombres de estudios) donde el match léxico gana al semántico, y (b) preguntas vagas/coloquiales ("cómo duermo mejor") donde el embedding de la pregunta cruda no se parece al embedding de los chunks relevantes. Cada etapa ataca un modo de fallo distinto:

- **Query rewriting** — normaliza la intención antes de embeddear, para que preguntas vagas recuperen contenido específico.
- **Hybrid search (RRF)** — combina señal semántica y léxica; recupera casos donde una sola señal no basta.
- **LLM rerank** — el top-K de RRF no siempre está ordenado por relevancia real a la pregunta original; un segundo paso de relevancia lo corrige antes de construir la respuesta.

## Evaluación

Metodología: set de 36 "preguntas doradas" ([`data/golden_questions.json`](data/golden_questions.json)) con ground truth (número de episodio esperado) **sacado directamente de la KB real**, nunca inventado — 28 preguntas específicas, 5 vagas, 3 de control fuera de tema (para verificar degradación honesta, no alucinación). Harness de evaluación 100% local: [`src/eval_rag.js`](src/eval_rag.js), mide Recall@8 y MRR (Mean Reciprocal Rank).

| Modo | Recall@8 | MRR | Score prom. preguntas fuera de tema |
|---|---|---|---|
| Vector puro (baseline, KB de resúmenes) | 33.3% (11/33) | 0.259 | 0.208 |
| Hybrid + rewriting + rerank | 36.4% (12/33) | 0.269 | 0.208 |
| Hybrid + chunks de transcript (Fase 3, ~27K filas) | 36.4% (12/33) | **0.289** | 0.217 |

Mejora real pero modesta — reportada sin inflar. El score de las preguntas de control se mantuvo estable (bajo), confirmando que el sistema no empezó a alucinar contenido para preguntas fuera de dominio al mejorar el recall. La Fase 3 no movió el Recall@8 (los chunks finos no agregan episodios nuevos al top-8), pero mejoró el MRR de forma consistente en ambos modos: cuando el sistema encuentra el episodio correcto, ahora lo rankea mejor porque existe una unidad de contenido específica en vez de solo el resumen del episodio completo. Ejemplo real: "¿qué es la L-teanina?" pasó de "no encontré información" (gap de granularidad documentado abajo) a una cita precisa del episodio correcto con timestamp.

## Caso de estudio: bug en producción (2026-07-11)

Un test de conversación real reportó una respuesta genérica sin citas de episodio para "¿qué es la L-teanina?", pese a que el pipeline de arriba estaba completo y medido. Diagnóstico por trazas de ejecución (no por prueba y error): el nodo de la herramienta RAG mostraba **cero invocaciones** para ese mensaje — el agente nunca llamó al pipeline, respondió de su conocimiento pretrained.

**Causa raíz:** la regla que obliga al agente a usar la herramienta de recuperación estaba escrita para el caso de uso comercial genérico de la plataforma compartida ("preguntas sobre la empresa: planes, precios, horarios..."). Una pregunta de salud no encaja en esa categoría, así que el agente, siguiendo correctamente sus propias instrucciones, nunca activó el RAG. El pipeline de recuperación era correcto; el *routing* hacia él no lo era.

**Fix:** el dominio que dispara la herramienta se parametrizó por tenant (con default que preserva el comportamiento de todos los demás tenants de la plataforma compartida), verificado en vivo contra el mensaje real antes de publicar a producción.

Lección: en un sistema RAG multi-tenant, "el pipeline de recuperación funciona" y "el pipeline de recuperación se invoca cuando debería" son cosas distintas que hay que verificar por separado — la segunda falla silenciosamente y no aparece en ninguna métrica de recall.

## Caso de estudio 2: timeout de Postgres al triplicar la KB (2026-07-12)

Inmediatamente después de la migración de Fase 3 (9,355 → ~27,254 filas), la función de hybrid search empezó a fallar con `57014: canceling statement due to statement timeout`. Causa raíz doble, confirmada consultando `pg_indexes` (no adivinando): (a) **nunca existió índice GIN** sobre la columna de full-text search — decisión consciente y documentada a 9K filas ("revisar si crece"), que dejó de ser válida al triplicar la tabla; (b) estadísticas del planner obsoletas tras el INSERT masivo. Fix en dos pasos aislados: `ANALYZE kb_documents` + `CREATE INDEX ... USING gin (content_tsv)` ([`sql/fase3_fix_hybrid_timeout.sql`](sql/fase3_fix_hybrid_timeout.sql)). La consulta pasó de timeout a ~1.5s.

Lección: una decisión de performance correcta a una escala ("no necesito este índice") lleva fecha de vencimiento implícita — documentarla junto a su condición de invalidez es lo que permitió diagnosticar esto en minutos.

## Fase 4 — citas accionables y modelo (2026-07-12)

- **Deep-links de YouTube al minuto exacto:** [`src/gen_youtube_map.js`](src/gen_youtube_map.js) construye el mapa `episode_number → youtube_id` (406 ids validados) desde el frontmatter de los transcripts; el nodo de formateo del RAG convierte `timestamp_start` a segundos y arma `https://youtu.be/<id>?t=<seg>`. Sin cambios de esquema ni re-embeddings: metadata derivada de la fuente canónica, incrustada en el paso de formateo.
- **Upgrade del modelo del agente** de `gpt-4.1-mini` a `gpt-4.1` (configurable por tenant, cambio de un solo campo): mejora medida en obediencia de instrucciones — mini inventaba URLs en la sección de fuentes; 4.1 respeta la regla "solo links que vengan de la recuperación".
- **Formato de respuesta iterado con feedback de usuario real:** el cuerpo va limpio (sin citas inline) y las fuentes se ofrecen bajo demanda — decisión de producto tras observar que el modelo omitía citas inconsistentemente cuando había muchos episodios juntos.

## Caso de estudio 3: regresión silenciosa de hybrid search, encontrada leyendo infraestructura real (2026-07-21)

Al proponer una optimización de búsqueda vectorial, la documentación interna decía "hybrid search en producción" — pero leer el nodo real de recuperación reveló que la función activa (`match_kb_published_documents_v2`) era **similitud coseno pura**. La función hybrid (RRF vector + full-text) seguía existiendo en la base pero había dejado de usarse en algún punto no documentado, como efecto secundario de una migración de plataforma que unificó el retrieval de todos los tenants bajo una función genérica del "Centro de Conocimiento" compartido — sin que nadie tomara la decisión explícita de sacrificar el hybrid para este bot.

Bonus al investigar: la función vieja tenía un bug propio no detectado — hardcodeaba `episode_number`/`timestamp_start` a `null` en vez de leerlos de la tabla, así que ni siquiera reactivarla tal cual hubiera arreglado las citas con deep-link.

**Fix:** función RPC nueva y aditiva (`match_kb_published_documents_hybrid_v1`, [`sql/fase5_hybrid_v1_and_standalone.sql`](sql/fase5_hybrid_v1_and_standalone.sql)) — no modifica la función en producción, mismo modelo de seguridad, usa el índice GIN existente sobre `content_tsv`, y de paso corrige el bug de los campos en `null`. El branch por función se resuelve en la capa de aplicación (config por tenant con allowlist explícito — nunca se interpola un string sin validar en la URL del RPC), default = comportamiento actual para cualquier tenant sin config, cero riesgo para el resto de la plataforma. Verificado con un caso real documentado (`¿qué dosis de teanina se recomienda?`): el chunk correcto tenía similitud vectorial ~0 y solo aparecía vía el componente full-text — confirmando que el hybrid search no es una mejora teórica, es la diferencia entre encontrar la respuesta o no.

**Efecto colateral encontrado y corregido:** con hybrid, un chunk top-ranked por RRF puede tener similitud vectorial 0 (si llegó solo por texto). El cálculo de confianza original tomaba el score del primer resultado post-rerank — con hybrid eso podía leer 0 y disparar falsos negativos. Fix: usar el máximo de similitud entre los chunks realmente citados, no el del primero.

Lección: la documentación describe una intención pasada; el estado real de un sistema en producción solo se confirma leyéndolo.

## Caso de estudio 4: de tool-calling agéntico a pipeline determinístico — eliminar la clase de bug, no parchearla (2026-07-21)

La limitación de citas fabricadas (Fase 4, arriba) tenía un diseño de arreglo pendiente: persistir el resultado del RAG y releerlo por un identificador de ejecución exacto (`turnId`), para que el nodo final pudiera construir las citas en código sin depender de si el agente decidió invocar la herramienta o no. Al empezar a implementarlo apareció un hallazgo que cambió el plan: el despachador de módulos — compartido por **todos** los tenants y **todos** los módulos de la plataforma (no solo RAG) — descarta silenciosamente cualquier campo no whitelisteado en tránsito. Ni siquiera un identificador de sesión llegaba hoy al pipeline de RAG. Implementar el mecanismo de correlación exacto requería tocar ese despachador compartido — blast radius alto para blindar un bot de un solo tenant.

**Decisión:** en vez de aumentar la sofisticación de la arquitectura compartida, reducir el acoplamiento del bot con ella. Extracción completa a un workflow único y autocontenido: mismo trigger de Telegram, misma capa de dedup, pero el pipeline de recuperación y composición corre inline, sin pasar por el router ni el motor de agente compartidos. El cambio de diseño más importante: **el retrieval dejó de ser una decisión de un agente con tool-calling y pasó a ser un paso incondicional del pipeline.** Sin una herramienta que un LLM pueda decidir no invocar, la clase de bug completa (citas fabricadas cuando el agente saltea el RAG) deja de ser posible — no hace falta ningún mecanismo de correlación cross-ejecución para blindarla.

Además, ya con cero dependencias de la plataforma compartida, se sumaron mejoras de producto que antes hubieran significado tocar infraestructura común: memoria de conversación propia con expiración (6h de inactividad reinicia el contexto), detección de saludos/chit-chat para no gastar una llamada de RAG completa en un "Hola", y las citas con deep-link vuelven a ofrecerse bajo demanda — pero ahora con un *fast path* que responde con los links de la última respuesta sin volver a correr el pipeline completo.

**Dos bugs reales de la migración, detectados en producción antes/después de publicar (no en desarrollo):**
- Un nodo que puede devolver legítimamente cero resultados (usuario sin historial previo) cortaba en silencio toda la cadena downstream — n8n no ejecuta nodos aguas abajo de un resultado vacío salvo que se declare explícitamente lo contrario.
- Reasignar un parámetro que ya existía en un nodo (en vez de crear uno nuevo) usando una ruta de tipo JSON Pointer falló silenciosamente dos veces — creó una ruta anidada nueva en vez de sobrescribir la real, dejando la expresión vieja activa. La API reportaba éxito y cada ejecución real mostraba `status: success`; el bot respondía igual un mensaje de error genérico a cada usuario. Solo fue visible comparando la salida calculada por el pipeline contra lo que el nodo de envío realmente mandó — la lección operativa: "la ejecución no lanzó error" no es lo mismo que "el resultado es el esperado".

Lección: cuando blindar una arquitectura compartida contra un caso límite requiere tocar más infraestructura común de la que el caso límite justifica, la opción correcta puede ser reducir el acoplamiento en vez de aumentar la sofisticación del blindaje.

## Limitaciones conocidas / roadmap

- **34/413 episodios fuera del índice de transcript** (formato de caption por línea distinto al de marcadores de capítulo) — pendiente extender el parser.
- **Cross-encoder reranker** dedicado en vez de LLM-rerank genérico, y benchmark más amplio que las 36 preguntas doradas.
- **Slot allocation por tipo de chunk** (resumen de episodio vs. segmento de transcript con timestamp): hoy compiten sin distinción por los mismos puestos del top-K; garantizar representación mínima de cada tipo podría mejorar la especificidad de las respuestas — identificado, no implementado.

## Stack

n8n Cloud (orquestación) · Supabase/Postgres + pgvector (vector store + full-text search + GIN full-text index) · OpenAI (`text-embedding-3-small`, `gpt-4.1` agente, `gpt-4.1-mini` rewriting/rerank) · Node.js (scripts de ingesta y evaluación, sin dependencias externas).

---

## Apéndice: pipeline de extracción y traducción de la fuente

Herramienta CLI usada para construir la KB cruda a partir del repositorio [Huberman-Lab-Wiki](https://github.com/PatrykWajs/Huberman-Lab-Wiki): extrae resúmenes/transcripts, los traduce al español y los compila en un índice JSON estructurado. Es la etapa previa a la ingesta descrita arriba (esta herramienta produce `data/raw/EP-XXX/`, que luego alimenta `src/migrate_to_supabase.js`).

### Instalación
```bash
npm install
```

### Configuración opcional (traducción vía Gemini)
Sin `GEMINI_API_KEY` cae automáticamente a la API web gratuita de Google Translate.
```bash
cp .env.example .env   # pegar GEMINI_API_KEY
```

### Uso
```bash
npm start   # menú interactivo
```

- **Opción 1 — Extracción:** trae resúmenes/transcripts crudos del repo clonado a `data/raw/EP-XXX/` (evita los problemas de rutas con `:` de Windows usando comandos Git directos).
- **Opción 2 — Traducción por lotes:** inglés→español (resúmenes y/o transcripts), con límite de lote configurable y progreso persistido en `data/translated/progress.json` (reanudable).
- **Opción 3 — Compilar base JSON:** agrega todo a `data/database/index.json` + `data/database/episodes/EP-XXX.json`.
- **Opción 4 — Test de búsqueda por keywords** (herramienta exploratoria previa al RAG real):
  ```bash
  node src/test_search.js "dormir"
  ```

### Esquema de `data/database/`
- `index.json`: metadata + resúmenes de los 413 episodios.
- `episodes/EP-XXX.json`:
  ```json
  {
    "id": "EP-XXX",
    "title_en": "English Title",
    "title_es": "Spanish Title",
    "summary_en": "Markdown...",
    "summary_es": "Markdown...",
    "transcript_en": "Markdown...",
    "transcript_es": "Markdown...",
    "has_summary": true,
    "has_summary_translated": true,
    "has_transcript": true,
    "has_transcript_translated": false
  }
  ```
