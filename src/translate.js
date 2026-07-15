const fs = require('fs');
const path = require('path');
require('dotenv').config();

const { GoogleGenerativeAI } = require('@google/generative-ai');
const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const Groq = require('groq-sdk');

const rawPath = path.resolve(__dirname, '..', 'data', 'raw');
const transPath = path.resolve(__dirname, '..', 'data', 'translated');

if (!fs.existsSync(transPath)) {
  fs.mkdirSync(transPath, { recursive: true });
}

const progressFilePath = path.join(transPath, 'progress.json');
let progress = {};
if (fs.existsSync(progressFilePath)) {
  try {
    progress = JSON.parse(fs.readFileSync(progressFilePath, 'utf8'));
  } catch (e) {
    console.error('Error loading progress.json, initializing fresh progress tracker.', e.message);
  }
}

// Tracks which episodeIds THIS process has modified, so concurrent parallel
// workers (each touching a different, non-overlapping set of episodes) never
// clobber each other's writes to progress.json.
const dirtyIds = new Set();

function markDirty(episodeId) {
  dirtyIds.add(episodeId);
}

function saveProgress() {
  let onDisk = {};
  if (fs.existsSync(progressFilePath)) {
    try {
      onDisk = JSON.parse(fs.readFileSync(progressFilePath, 'utf8'));
    } catch (e) {
      onDisk = {};
    }
  }
  for (const id of dirtyIds) {
    onDisk[id] = progress[id];
  }
  // Una vez volcados a disco, ya no hace falta seguir reaplicándolos en cada
  // guardado futuro: si se dejan en el set, un cambio externo (p. ej. este
  // mismo script revirtiendo un episodio corrupto) sería "resucitado" por el
  // próximo saveProgress() de este mismo proceso, aunque ya no sea el estado
  // real en disco.
  dirtyIds.clear();
  fs.writeFileSync(progressFilePath, JSON.stringify(onDisk, null, 2), 'utf8');
  progress = onDisk;
}

// ─── Key Rotator Factory ─────────────────────────────────────────────────────
function buildKeyRotator(prefix) {
  const keys = [];
  if (process.env[prefix]) keys.push(process.env[prefix]);
  let i = 2;
  while (process.env[`${prefix}_${i}`]) {
    keys.push(process.env[`${prefix}_${i}`]);
    i++;
  }

  if (keys.length === 0) throw new Error(`No ${prefix} found in environment variables.`);

  const unique = [...new Set(keys)];
  console.log(`  [KeyRotator] Loaded ${unique.length} API key(s) for ${prefix}.`);

  let current = 0;
  const cooldowns = new Array(unique.length).fill(0);
  let consecutiveCooldown = 0;

  return {
    count: unique.length,
    getKey() {
      return unique[current];
    },
    rotateDueToRateLimit() {
      cooldowns[current] = Date.now() + 60000;
      const start = current;
      do {
        current = (current + 1) % unique.length;
        if (cooldowns[current] < Date.now()) return true;
      } while (current !== start);
      return false; // all keys cooling down
    },
    allExhausted() {
      return unique.every((_, i) => cooldowns[i] > Date.now());
    },
    markSuccess() {
      consecutiveCooldown = 0;
    },
    incrementConsecutiveCooldown() {
      consecutiveCooldown++;
    },
    getConsecutiveCooldown() {
      return consecutiveCooldown;
    }
  };
}

const systemInstruction = 
  `You are an expert translator specializing in science, health, and podcast content. ` +
  `Translate the following English podcast content into natural, clear, and engaging Spanish (Latin American / Neutral). ` +
  `CRITICAL REQUIREMENTS:\n` +
  `1. Maintain ALL Markdown formatting (headings, bold, lists, links) EXACTLY as in the original.\n` +
  `2. Keep all timestamps (e.g. [00:12:34]) EXACTLY as they are in the text.\n` +
  `3. In the YAML frontmatter (between --- lines), translate only human-readable text like "title". Do NOT translate field names (type, episode_date, speakers, youtube_id, search, exclude) or their literal values (e.g. keep "type: transcript" exactly as "type: transcript", not "transcripción").\n` +
  `4. IMPORTANT: The content you receive may be a MID-DOCUMENT FRAGMENT of a much longer transcript, cut off at an arbitrary point (e.g. starting or ending mid-sentence). This is expected and normal. NEVER invent, add, or complete a "---" line, a YAML frontmatter block, or a "title:" field unless that exact text is already literally present in the input you were given. Just translate the fragment as plain continuous text, even if it starts or ends abruptly.\n` +
  `5. NEVER summarize, condense, paraphrase, or skip ANY part of the content, even if it seems repetitive, redundant, filler, or conversational (e.g. "um", "you know", false starts, repeated words, back-and-forth dialogue). Translate EVERY sentence and EVERY line completely and literally, in full, exactly as thorough as the original, no matter how long or repetitive the input is. This is a strict requirement: the translated output must be complete and equivalent in length/detail to the input, not a shorter summary of it.\n` +
  `6. Return ONLY the translated markdown text. Do not add any introductory or concluding remarks, explanations, or wrapper tags.`;

// ─── Anthropic (Claude) Translate ─────────────────────────────────────────────
async function translateTextAnthropic(text, keyRotator) {
  const callWithRotation = async (prompt) => {
    let hardRetries = 5;
    while (hardRetries > 0) {
      const apiKey = keyRotator.getKey();
      const anthropic = new Anthropic({ apiKey });
      try {
        const response = await anthropic.messages.create({
          model: 'claude-3-haiku-20240307',
          max_tokens: 4096, // tope máximo de salida del modelo (no se puede subir más)
          system: systemInstruction,
          messages: [{ role: 'user', content: `Content to translate:\n\n${prompt}` }]
        });
        if (response.stop_reason === 'max_tokens') {
          throw new Error('ANTHROPIC_TRUNCATED_OUTPUT: la respuesta se cortó por max_tokens');
        }
        keyRotator.markSuccess();
        return response.content[0].text.trim();
      } catch (err) {
        const isRateLimit = err.status === 429 || (err.message && err.message.includes('429'));
        
        if (isRateLimit) {
          const rotated = keyRotator.rotateDueToRateLimit();
          if (rotated) continue;
          
          keyRotator.incrementConsecutiveCooldown();
          if (keyRotator.getConsecutiveCooldown() >= 3) {
            console.warn(`\n  🛑 TODAS las cuentas de Anthropic alcanzaron su límite diario.`);
            console.warn(`  Deteniendo el proceso.\n`);
            const err = new Error('ALL_KEYS_EXHAUSTED');
            err.code = 'ALL_KEYS_EXHAUSTED';
            throw err;
          }

          console.warn(`    All Anthropic keys rate-limited or out of quota. Sleeping 60s (Attempt ${keyRotator.getConsecutiveCooldown()}/3)...`);
          await new Promise(r => setTimeout(r, 60000));
          continue;
        }

        hardRetries--;
        console.warn(`    Anthropic error. Retries left: ${hardRetries}. Error: ${err.message}`);
        if (hardRetries === 0) throw err;
        await new Promise(r => setTimeout(r, 5000));
      }
    }
    throw new Error('Max hard retries exceeded for Anthropic.');
  };

  // Claude 3 Haiku tiene un tope DURO de 4096 tokens de salida (no configurable
  // más alto), así que el fragmento de entrada debe ser pequeño para que la
  // traducción al español quepa sin cortarse.
  const maxChunkSize = 10000;
  if (text.length <= maxChunkSize) {
    return await callWithRotation(text);
  } else {
    console.log(`  Text size (${text.length} chars) exceeds chunk limit. Translating in chunks...`);
    const paragraphs = text.split('\n');
    let currentChunk = '';
    const chunks = [];

    for (const para of paragraphs) {
      if (currentChunk.length + para.length + 1 > maxChunkSize) {
        if (currentChunk) chunks.push(currentChunk);
        currentChunk = para;
      } else {
        currentChunk = currentChunk ? currentChunk + '\n' + para : para;
      }
    }
    if (currentChunk) chunks.push(currentChunk);

    let translatedText = '';
    for (let i = 0; i < chunks.length; i++) {
      console.log(`  Translating chunk ${i + 1}/${chunks.length} via Anthropic...`);
      const translatedChunk = await callWithRotation(chunks[i]);
      translatedText += translatedChunk + '\n\n';
      await new Promise(r => setTimeout(r, 500)); 
    }
    return translatedText.trim();
  }
}

// ─── OpenAI Translate ─────────────────────────────────────────────────────────
async function translateTextOpenAI(text, keyRotator) {
  const callWithRotation = async (prompt) => {
    let hardRetries = 5;
    while (hardRetries > 0) {
      const apiKey = keyRotator.getKey();
      const openai = new OpenAI({ apiKey });
      try {
        const response = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemInstruction },
            { role: 'user', content: `Content to translate:\n\n${prompt}` }
          ],
          temperature: 0.3,
          max_tokens: 16000,
        });
        const choice = response.choices[0];
        if (choice.finish_reason === 'length') {
          throw new Error('OPENAI_TRUNCATED_OUTPUT: la respuesta se cortó por max_tokens (finish_reason=length)');
        }
        keyRotator.markSuccess();
        return choice.message.content.trim();
      } catch (err) {
        const isRateLimit = err.status === 429 || (err.message && err.message.includes('429'));

        if (isRateLimit) {
          const rotated = keyRotator.rotateDueToRateLimit();
          if (rotated) continue;

          keyRotator.incrementConsecutiveCooldown();
          if (keyRotator.getConsecutiveCooldown() >= 3) {
            console.warn(`\n  🛑 TODAS las cuentas de OpenAI alcanzaron su límite diario.`);
            console.warn(`  Deteniendo el proceso.\n`);
            const err = new Error('ALL_KEYS_EXHAUSTED');
            err.code = 'ALL_KEYS_EXHAUSTED';
            throw err;
          }

          console.warn(`    All OpenAI keys rate-limited or out of quota. Sleeping 60s (Attempt ${keyRotator.getConsecutiveCooldown()}/3)...`);
          await new Promise(r => setTimeout(r, 60000));
          continue;
        }

        hardRetries--;
        console.warn(`    OpenAI error. Retries left: ${hardRetries}. Error: ${err.message}`);
        if (hardRetries === 0) throw err;
        await new Promise(r => setTimeout(r, 5000));
      }
    }
    throw new Error('Max hard retries exceeded for OpenAI.');
  };

  const maxChunkSize = 30000;
  if (text.length <= maxChunkSize) {
    return await callWithRotation(text);
  } else {
    console.log(`  Text size (${text.length} chars) exceeds chunk limit. Translating in chunks...`);
    const paragraphs = text.split('\n');
    let currentChunk = '';
    const chunks = [];

    for (const para of paragraphs) {
      if (currentChunk.length + para.length + 1 > maxChunkSize) {
        if (currentChunk) chunks.push(currentChunk);
        currentChunk = para;
      } else {
        currentChunk = currentChunk ? currentChunk + '\n' + para : para;
      }
    }
    if (currentChunk) chunks.push(currentChunk);

    let translatedText = '';
    for (let i = 0; i < chunks.length; i++) {
      console.log(`  Translating chunk ${i + 1}/${chunks.length} via OpenAI...`);
      const translatedChunk = await callWithRotation(chunks[i]);
      translatedText += translatedChunk + '\n\n';
      await new Promise(r => setTimeout(r, 500));
    }
    return translatedText.trim();
  }
}

// ─── DeepSeek Translate (API compatible con OpenAI) ───────────────────────────
async function translateTextDeepSeek(text, keyRotator) {
  const callWithRotation = async (prompt) => {
    let hardRetries = 5;
    while (hardRetries > 0) {
      const apiKey = keyRotator.getKey();
      const deepseek = new OpenAI({ apiKey, baseURL: 'https://api.deepseek.com' });
      try {
        const response = await deepseek.chat.completions.create({
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: systemInstruction },
            { role: 'user', content: `Content to translate:\n\n${prompt}` }
          ],
          temperature: 0.3,
          max_tokens: 8192,
        });
        const choice = response.choices[0];
        if (choice.finish_reason === 'length') {
          // La respuesta se cortó por el límite de tokens de salida antes de
          // terminar de traducir el fragmento -> no es un resultado usable,
          // hay que forzar un reintento (con más suerte no ayudará si el
          // fragmento en sí es demasiado grande, pero al menos no lo
          // aceptamos silenciosamente truncado).
          throw new Error('DEEPSEEK_TRUNCATED_OUTPUT: la respuesta se cortó por max_tokens (finish_reason=length)');
        }
        keyRotator.markSuccess();
        return choice.message.content.trim();
      } catch (err) {
        const isRateLimit = err.status === 429 || (err.message && err.message.includes('429'));
        const isInsufficientBalance = err.status === 402 || (err.message && err.message.includes('Insufficient Balance'));

        if (isInsufficientBalance) {
          console.warn(`\n  🛑 Saldo insuficiente en la cuenta de DeepSeek.`);
          const err2 = new Error('ALL_KEYS_EXHAUSTED');
          err2.code = 'ALL_KEYS_EXHAUSTED';
          throw err2;
        }

        if (isRateLimit) {
          const rotated = keyRotator.rotateDueToRateLimit();
          if (rotated) continue;

          keyRotator.incrementConsecutiveCooldown();
          if (keyRotator.getConsecutiveCooldown() >= 3) {
            console.warn(`\n  🛑 TODAS las cuentas de DeepSeek alcanzaron su límite.`);
            console.warn(`  Deteniendo el proceso.\n`);
            const err2 = new Error('ALL_KEYS_EXHAUSTED');
            err2.code = 'ALL_KEYS_EXHAUSTED';
            throw err2;
          }

          console.warn(`    All DeepSeek keys rate-limited. Sleeping 60s (Attempt ${keyRotator.getConsecutiveCooldown()}/3)...`);
          await new Promise(r => setTimeout(r, 60000));
          continue;
        }

        hardRetries--;
        console.warn(`    DeepSeek error. Retries left: ${hardRetries}. Error: ${err.message}`);
        if (hardRetries === 0) throw err;
        await new Promise(r => setTimeout(r, 5000));
      }
    }
    throw new Error('Max hard retries exceeded for DeepSeek.');
  };

  // Tamaño conservador: con max_tokens=8192 de salida, un fragmento de
  // entrada más grande que esto arriesga que la traducción al español
  // (que puede ser más larga que el inglés) exceda el límite de tokens de
  // salida y la respuesta se corte a mitad de texto (finish_reason=length).
  const maxChunkSize = 15000;
  if (text.length <= maxChunkSize) {
    return await callWithRotation(text);
  } else {
    console.log(`  Text size (${text.length} chars) exceeds chunk limit. Translating in chunks...`);
    const paragraphs = text.split('\n');
    let currentChunk = '';
    const chunks = [];

    for (const para of paragraphs) {
      if (currentChunk.length + para.length + 1 > maxChunkSize) {
        if (currentChunk) chunks.push(currentChunk);
        currentChunk = para;
      } else {
        currentChunk = currentChunk ? currentChunk + '\n' + para : para;
      }
    }
    if (currentChunk) chunks.push(currentChunk);

    // Traduce un fragmento con reintentos; si tras 3 intentos al mismo tamaño
    // sigue saliendo sospechosamente corto (probable resumen en vez de
    // traducción completa), lo divide a la mitad y traduce cada mitad por
    // separado de forma recursiva. Fragmentos más pequeños le dan al modelo
    // menos "espacio" para decidir condensar el contenido. Tiene un límite
    // de profundidad para no partir indefinidamente un fragmento problemático.
    const translateChunkWithFallback = async (chunkText, label, depth) => {
      let translated = await callWithRotation(chunkText);

      let chunkRetries = 3;
      while (translated.length < chunkText.length * 0.65 && chunkRetries > 0) {
        console.warn(`    Fragmento ${label} salió sospechosamente corto (${translated.length}/${chunkText.length} chars) - probable resumen. Reintentando (${chunkRetries} intentos restantes)...`);
        chunkRetries--;
        await new Promise(r => setTimeout(r, 2000));
        translated = await callWithRotation(chunkText);
      }

      if (translated.length < chunkText.length * 0.65) {
        if (depth >= 3 || chunkText.length < 800) {
          console.warn(`    Fragmento ${label} sigue corto tras dividir al máximo permitido. Se conserva el mejor resultado obtenido.`);
          return translated;
        }
        console.warn(`    Fragmento ${label} sigue corto tras 3 reintentos. Dividiendo a la mitad y retraduciendo por separado...`);
        // Preferir partir por líneas (no corta palabras/oraciones a la
        // mitad), pero si el fragmento es esencialmente una sola línea larga
        // (formato subtítulo con timestamps pegados, sin saltos de línea
        // internos), partir por el espacio más cercano al punto medio en
        // caracteres para no quedarnos en un bucle infinito sin reducir tamaño.
        const lines = chunkText.split('\n');
        let firstHalf, secondHalf;
        if (lines.length > 1) {
          const mid = Math.floor(lines.length / 2) || 1;
          firstHalf = lines.slice(0, mid).join('\n');
          secondHalf = lines.slice(mid).join('\n');
        }
        // Si partir por líneas no dio dos mitades razonablemente balanceadas
        // (p. ej. una sola línea gigante domina el fragmento, típico de
        // formato subtítulo con timestamps pegados), partir por el espacio
        // más cercano al punto medio en caracteres en su lugar.
        const balancedEnough = firstHalf && secondHalf &&
          firstHalf.length > chunkText.length * 0.15 &&
          secondHalf.length > chunkText.length * 0.15;
        if (!balancedEnough) {
          const midpoint = Math.floor(chunkText.length / 2);
          let splitAt = chunkText.indexOf(' ', midpoint);
          if (splitAt === -1) splitAt = midpoint;
          firstHalf = chunkText.slice(0, splitAt);
          secondHalf = chunkText.slice(splitAt);
        }
        const [firstTranslated, secondTranslated] = await Promise.all([
          translateChunkWithFallback(firstHalf, `${label}a`, depth + 1),
          translateChunkWithFallback(secondHalf, `${label}b`, depth + 1),
        ]);
        return firstTranslated.trim() + '\n\n' + secondTranslated.trim();
      }

      return translated;
    };

    let translatedText = '';
    for (let i = 0; i < chunks.length; i++) {
      console.log(`  Translating chunk ${i + 1}/${chunks.length} via DeepSeek...`);
      const translatedChunk = await translateChunkWithFallback(chunks[i], String(i + 1), 0);
      translatedText += translatedChunk + '\n\n';
      await new Promise(r => setTimeout(r, 500));
    }
    return translatedText.trim();
  }
}

// ─── Gemini Translate ─────────────────────────────────────────────────────────
async function translateTextGemini(text, keyRotator) {
  const callWithRotation = async (prompt) => {
    let hardRetries = 5;
    while (hardRetries > 0) {
      const apiKey = keyRotator.getKey();
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({
        model: 'gemini-2.5-flash',
        generationConfig: { maxOutputTokens: 60000 }, // gemini-2.5-flash soporta hasta 65536
      });
      try {
        const result = await model.generateContent(prompt);
        const finishReason = result.response.candidates && result.response.candidates[0] && result.response.candidates[0].finishReason;
        if (finishReason === 'MAX_TOKENS') {
          throw new Error('GEMINI_TRUNCATED_OUTPUT: la respuesta se cortó por maxOutputTokens');
        }
        keyRotator.markSuccess();
        return result.response.text().trim();
      } catch (err) {
        const isRateLimit =
          err.message.includes('429') ||
          err.message.includes('Quota exceeded') ||
          err.message.includes('ResourceExhausted') ||
          err.message.includes('RESOURCE_EXHAUSTED');

        const isUnavailable = err.message.includes('503') || err.message.includes('Service Unavailable');

        if (isRateLimit) {
          const rotated = keyRotator.rotateDueToRateLimit();
          if (rotated) continue;
          
          keyRotator.incrementConsecutiveCooldown();
          if (keyRotator.getConsecutiveCooldown() >= 3) {
            console.warn(`\n  🛑 TODAS las cuentas de Gemini alcanzaron su límite diario.`);
            console.warn(`  Deteniendo el proceso. Reinicia mañana a las 3:00 AM.\n`);
            const err = new Error('ALL_KEYS_EXHAUSTED');
            err.code = 'ALL_KEYS_EXHAUSTED';
            throw err;
          }

          console.warn(`\n    All keys rate-limited. Sleeping 90s to clear temporary limits (Attempt ${keyRotator.getConsecutiveCooldown()}/3)...`);
          await new Promise(r => setTimeout(r, 90000));
          continue;
        }

        if (isUnavailable) {
          console.warn(`    Service unavailable (503). Waiting 30s...`);
          await new Promise(r => setTimeout(r, 30000));
          hardRetries--;
          continue;
        }

        hardRetries--;
        console.warn(`    Gemini error. Retries left: ${hardRetries}. Error: ${err.message}`);
        if (hardRetries === 0) throw err;
        await new Promise(r => setTimeout(r, 5000));
      }
    }
    throw new Error('Max hard retries exceeded.');
  };

  const maxChunkSize = 30000;
  if (text.length <= maxChunkSize) {
    const prompt = `${systemInstruction}\n\nContent to translate:\n\n${text}`;
    return await callWithRotation(prompt);
  } else {
    console.log(`  Text size (${text.length} chars) exceeds chunk limit. Translating in chunks...`);
    const paragraphs = text.split('\n');
    let currentChunk = '';
    const chunks = [];

    for (const para of paragraphs) {
      if (currentChunk.length + para.length + 1 > maxChunkSize) {
        if (currentChunk) chunks.push(currentChunk);
        currentChunk = para;
      } else {
        currentChunk = currentChunk ? currentChunk + '\n' + para : para;
      }
    }
    if (currentChunk) chunks.push(currentChunk);

    let translatedText = '';
    for (let i = 0; i < chunks.length; i++) {
      console.log(`  Translating chunk ${i + 1}/${chunks.length}...`);
      const prompt = `${systemInstruction}\n\nContent to translate (Part ${i + 1} of ${chunks.length}):\n\n${chunks[i]}`;
      const translatedChunk = await callWithRotation(prompt);
      translatedText += translatedChunk + '\n\n';
      await new Promise(r => setTimeout(r, 5000)); 
    }
    return translatedText.trim();
  }
}

// ─── Groq Translate ───────────────────────────────────────────────────────────
async function translateTextGroq(text, keyRotator) {
  const callWithRotation = async (prompt) => {
    let hardRetries = 5;
    while (hardRetries > 0) {
      const apiKey = keyRotator.getKey();
      const groq = new Groq({ apiKey });
      try {
        const response = await groq.chat.completions.create({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: systemInstruction },
            { role: 'user', content: `Content to translate:\n\n${prompt}` }
          ],
          temperature: 0.3,
          max_tokens: 4500, // limite TPM de Groq (12000) incluye max_tokens reservado + input + system prompt
        });
        const choice = response.choices[0];
        if (choice.finish_reason === 'length') {
          throw new Error('GROQ_TRUNCATED_OUTPUT: la respuesta se cortó por max_tokens (finish_reason=length)');
        }
        keyRotator.markSuccess();
        return choice.message.content.trim();
      } catch (err) {
        const isRateLimit = err.status === 429 || (err.message && err.message.includes('429'));

        if (isRateLimit) {
          console.warn(`    Rate limit hit on Groq. Error: ${err.message}`);
          const rotated = keyRotator.rotateDueToRateLimit();
          if (rotated) continue;

          keyRotator.incrementConsecutiveCooldown();
          if (keyRotator.getConsecutiveCooldown() >= 3) {
            console.warn(`\n  🛑 Groq alcanzó su límite.`);
            const err2 = new Error('ALL_KEYS_EXHAUSTED');
            err2.code = 'ALL_KEYS_EXHAUSTED';
            throw err2;
          }

          console.warn(`    All Groq keys rate-limited. Sleeping 60s (Attempt ${keyRotator.getConsecutiveCooldown()}/3)...`);
          await new Promise(r => setTimeout(r, 60000));
          continue;
        }

        hardRetries--;
        console.warn(`    Groq error. Retries left: ${hardRetries}. Error: ${err.message}`);
        if (hardRetries === 0) throw err;
        await new Promise(r => setTimeout(r, 5000));
      }
    }
    throw new Error('Max hard retries exceeded for Groq.');
  };

  const maxChunkSize = 3500;
  if (text.length <= maxChunkSize) {
    return await callWithRotation(text);
  } else {
    console.log(`  Text size (${text.length} chars) exceeds chunk limit. Translating in chunks...`);
    const paragraphs = text.split('\n');
    let currentChunk = '';
    const chunks = [];

    for (const para of paragraphs) {
      if (currentChunk.length + para.length + 1 > maxChunkSize) {
        if (currentChunk) chunks.push(currentChunk);
        currentChunk = para;
      } else {
        currentChunk = currentChunk ? currentChunk + '\n' + para : para;
      }
    }
    if (currentChunk) chunks.push(currentChunk);

    let translatedText = '';
    for (let i = 0; i < chunks.length; i++) {
      console.log(`  Translating chunk ${i + 1}/${chunks.length} via Groq...`);
      const translatedChunk = await callWithRotation(chunks[i]);
      translatedText += translatedChunk + '\n\n';
      await new Promise(r => setTimeout(r, 10000));
    }
    return translatedText.trim();
  }
}

const lmstudioSystemInstruction =
  `You are a translation engine. Translate the following English text into natural, clear Spanish (Latin American / Neutral). ` +
  `STRICT RULES:\n` +
  `1. Output ONLY the translated text, nothing else.\n` +
  `2. Do NOT repeat, quote, or reference these instructions in your output.\n` +
  `3. Do NOT add any heading, title, or line that is not a direct translation of a line present in the input.\n` +
  `4. Do NOT add markdown headings (##) unless the exact same heading already exists in the input text. The input may be a mid-document fragment cut off mid-sentence - never invent a "---" line, YAML frontmatter, or "title:" field to "complete" it.\n` +
  `5. Keep timestamps like [00:12:34] and speaker tags like **Name:** EXACTLY as they are.\n` +
  `6. Preserve the exact number of paragraphs and line breaks as the input.\n` +
  `7. Never explain, summarize, or comment on the text. Only translate it.`;

// ─── LM Studio (Local) Translate ──────────────────────────────────────────────
async function translateTextLMStudio(text, modelName) {
  const lmstudio = new OpenAI({
    baseURL: 'http://localhost:1234/v1',
    apiKey: 'lm-studio', // not checked by LM Studio, but the SDK requires a value
  });

  const callOnce = async (prompt) => {
    let hardRetries = 5;
    while (hardRetries > 0) {
      try {
        const response = await lmstudio.chat.completions.create({
          model: modelName,
          messages: [
            { role: 'system', content: lmstudioSystemInstruction },
            { role: 'user', content: `Content to translate:\n\n${prompt}` }
          ],
          temperature: 0,
        });
        return response.choices[0].message.content.trim();
      } catch (err) {
        hardRetries--;
        const isConnRefused = err.message && err.message.includes('ECONNREFUSED');
        if (isConnRefused) {
          console.error(`\n  🛑 No se puede conectar con LM Studio en http://localhost:1234.`);
          console.error(`  Abre LM Studio, ve a la pestaña "Developer" y presiona "Start Server".\n`);
          const err2 = new Error('LMSTUDIO_UNREACHABLE');
          err2.code = 'ALL_KEYS_EXHAUSTED'; // reuse the same stop mechanism
          throw err2;
        }
        console.warn(`    LM Studio error. Retries left: ${hardRetries}. Error: ${err.message}`);
        if (hardRetries === 0) throw err;
        await new Promise(r => setTimeout(r, 3000));
      }
    }
    throw new Error('Max hard retries exceeded for LM Studio.');
  };

  // Local models have small context windows, so chunk more aggressively.
  const maxChunkSize = 3000;
  if (text.length <= maxChunkSize) {
    return await callOnce(text);
  } else {
    console.log(`  Text size (${text.length} chars) exceeds chunk limit. Translating in chunks...`);
    const paragraphs = text.split('\n');
    let currentChunk = '';
    const chunks = [];

    for (const para of paragraphs) {
      if (currentChunk.length + para.length + 1 > maxChunkSize) {
        if (currentChunk) chunks.push(currentChunk);
        currentChunk = para;
      } else {
        currentChunk = currentChunk ? currentChunk + '\n' + para : para;
      }
    }
    if (currentChunk) chunks.push(currentChunk);

    let translatedText = '';
    for (let i = 0; i < chunks.length; i++) {
      console.log(`  Translating chunk ${i + 1}/${chunks.length} via LM Studio...`);
      const translatedChunk = await callOnce(chunks[i]);
      translatedText += translatedChunk + '\n\n';
    }
    return translatedText.trim();
  }
}

// ─── File Translator ──────────────────────────────────────────────────────────
async function translateFile(episodeId, fileType, engine, keyRotator) {
  const fileName = `${fileType}.md`;
  const inputFilePath = path.join(rawPath, episodeId, fileName);
  const outputEpisodeDir = path.join(transPath, episodeId);
  const outputFilePath = path.join(outputEpisodeDir, fileName);

  if (!fs.existsSync(inputFilePath)) return false;

  if (!fs.existsSync(outputEpisodeDir)) {
    fs.mkdirSync(outputEpisodeDir, { recursive: true });
  }

  const content = fs.readFileSync(inputFilePath, 'utf8');
  if (!content.trim()) return false;

  let translatedContent = '';
  if (engine === 'gemini') {
    translatedContent = await translateTextGemini(content, keyRotator);
  } else if (engine === 'openai') {
    translatedContent = await translateTextOpenAI(content, keyRotator);
  } else if (engine === 'anthropic') {
    translatedContent = await translateTextAnthropic(content, keyRotator);
  } else if (engine === 'groq') {
    translatedContent = await translateTextGroq(content, keyRotator);
  } else if (engine === 'deepseek') {
    translatedContent = await translateTextDeepSeek(content, keyRotator);
  } else if (engine === 'lmstudio') {
    translatedContent = await translateTextLMStudio(content, keyRotator.modelName);
  } else {
    throw new Error(`Engine ${engine} is not supported.`);
  }

  fs.writeFileSync(outputFilePath, translatedContent, 'utf8');
  return true;
}

// ─── Main Runner ──────────────────────────────────────────────────────────────
async function runTranslation(options = {}) {
  const {
    engine = 'gemini',   // 'gemini', 'openai', 'anthropic', 'groq', or 'lmstudio'
    mode = 'summaries',  // 'summaries', 'transcripts', or 'all'
    limit = 10,          // number of episodes, or 'all'
    lmstudioModel = 'google/gemma-2-9b',
  } = options;

  let keyRotator = null;
  try {
    if (engine === 'gemini') {
      keyRotator = buildKeyRotator('GEMINI_API_KEY');
    } else if (engine === 'openai') {
      keyRotator = buildKeyRotator('OPENAI_API_KEY');
    } else if (engine === 'anthropic') {
      keyRotator = buildKeyRotator('ANTHROPIC_API_KEY');
    } else if (engine === 'groq') {
      keyRotator = buildKeyRotator('GROQ_API_KEY');
    } else if (engine === 'deepseek') {
      keyRotator = buildKeyRotator('DEEPSEEK_API_KEY');
    } else if (engine === 'lmstudio') {
      keyRotator = { modelName: lmstudioModel }; // no key rotation needed for local server
    }
  } catch (e) {
    console.error('ERROR:', e.message);
    return;
  }

  const indexFilePath = path.join(rawPath, 'index.json');
  if (!fs.existsSync(indexFilePath)) {
    console.error('ERROR: raw index.json not found. Please run extract first.');
    return;
  }

  const metadata = JSON.parse(fs.readFileSync(indexFilePath, 'utf8'));
  const episodeIds = options.episodeIds
    ? options.episodeIds.filter(id => metadata[id])
    : Object.keys(metadata);

  console.log(`Starting translation using [${engine}] engine in [${mode}] mode.`);
  console.log(`Episodes assigned to this run: ${episodeIds.length}. Max limit for this run: ${limit}`);

  let processedCount = 0;

  for (const episodeId of episodeIds) {
    if (limit !== 'all' && processedCount >= limit) {
      console.log(`Reached limit of ${limit} episodes for this run.`);
      break;
    }

    if (!progress[episodeId]) {
      progress[episodeId] = { summary: false, transcript: false };
    }

    let madeProgress = false;

    // Translate Summary
    if ((mode === 'summaries' || mode === 'all') && metadata[episodeId].hasSummary && !progress[episodeId].summary) {
      console.log(`Translating summary for ${episodeId}...`);
      try {
        const ok = await translateFile(episodeId, 'summary', engine, keyRotator);
        if (ok) {
          progress[episodeId].summary = true;
          madeProgress = true;
          markDirty(episodeId);
          saveProgress();
          console.log(`  Summary for ${episodeId} translated successfully.`);
        }
      } catch (err) {
        if (err.code === 'ALL_KEYS_EXHAUSTED') {
          console.log(`\nProgreso guardado. Episodios completados en esta sesión: ${processedCount}`);
          process.exit(0);
        }
        console.error(`  Failed to translate summary for ${episodeId}:`, err.message);
      }
    }

    // Translate Transcript
    if ((mode === 'transcripts' || mode === 'all') && metadata[episodeId].hasTranscript && !progress[episodeId].transcript) {
      console.log(`Translating transcript for ${episodeId} (this may take a while)...`);
      try {
        const ok = await translateFile(episodeId, 'transcript', engine, keyRotator);
        if (ok) {
          progress[episodeId].transcript = true;
          madeProgress = true;
          markDirty(episodeId);
          saveProgress();
          console.log(`  Transcript for ${episodeId} translated successfully.`);
        }
      } catch (err) {
        if (err.code === 'ALL_KEYS_EXHAUSTED') {
          console.log(`\nProgreso guardado. Episodios completados en esta sesión: ${processedCount}`);
          process.exit(0);
        }
        console.error(`  Failed to translate transcript for ${episodeId}:`, err.message);
      }
    }

    if (madeProgress) {
      processedCount++;
      if (engine === 'gemini') {
        await new Promise(r => setTimeout(r, 5000));
      } else {
        await new Promise(r => setTimeout(r, 1000)); 
      }
    }
  }

  console.log(`Translation run finished. Processed ${processedCount} episodes.`);
}

module.exports = { runTranslation };
