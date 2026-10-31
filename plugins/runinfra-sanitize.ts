// Sanea los mensajes que opencode (v2) envía al proveedor "runinfra".
//  - Límites de RunInfra: máx. 8 imágenes por petición (cuenta todo el historial) y
//    cuerpo de petición de máx. 3,5 MB. Las partes no se borran: los pares
//    tool-call/tool-result quedan intactos.
//  - Caché de prompts (https://runinfra.ai/docs/cookbook/prompt-caching.md): RunInfra reutiliza
//    el prefijo byte a byte idéntico más largo con una petición anterior; todo lo que va después
//    de la primera diferencia se cobra sin caché (~10× más caro). Por eso los recortes van por
//    lotes con histéresis: al pasar un umbral alto se recorta de golpe hasta un umbral bajo, la
//    decisión se guarda por sesión y las peticiones siguientes repiten exactamente los mismos
//    recortes (mismos bytes) y solo añaden al final, hasta que se vuelve a pasar el umbral alto.
//  - Imágenes: si las conservadas pasan de IMAGES_MAX o su base64 en línea de INLINE_HIGH, se
//    descartan las más antiguas hasta IMAGES_LOW / INLINE_LOW (sin bajar de las imágenes nuevas
//    de esta petición mientras quepan en IMAGES_MAX / INLINE_HIGH). Una imagen que sola pasa de
//    INLINE_HIGH se descarta siempre. Cada aparición se identifica por el id de su tool call
//    (o, en adjuntos, por hash + ordinal): si el modelo vuelve a leer una imagen descartada, la
//    nueva lectura es otra aparición y se ve.
//  - Etiquetas estables: cada imagen recibe un número por orden de primera aparición. Antes de
//    cada imagen conservada va "[imagen N · ruta · descripción]"; cada imagen descartada se
//    sustituye por "[imagen N omitida · ruta · descripción · vuelve a leer ...]". Número, ruta y
//    descripción se fijan la primera vez que se ve cada aparición, así que la etiqueta no cambia.
//  - Estado por sesión en $XDG_CACHE_HOME/opencode-runinfra/<sesión>/index.json (no depende de
//    los mensajes, así que sobrevive a la compactación): numeración, apariciones de imágenes
//    (ruta, descripción, descartada) e ids de tool calls recortados. Los conjuntos solo crecen.
//  - Ruta: la del archivo leído con read (o el nombre del adjunto) si existe en disco
//    con el mismo tamaño; si no (adjuntos pegados, salida de shell, data URIs), se
//    guarda una copia una sola vez en $XDG_CACHE_HOME/opencode-runinfra/<sesión>/imagen-NN.ext.
//  - Descripciones: una línea en español por imagen, generada una sola vez (caché por
//    hash de contenido) con el modelo de RunInfra con entrada de imagen más barato según
//    GET /models (input_modalities + pricing; caché 24 h). Forzar modelo con
//    OPENCODE_RUNINFRA_CAPTION_MODEL. Si /models no publicara input_modalities se usa
//    qwen3-8-27b. Ante cualquier fallo la etiqueta lleva solo número y ruta.
//  - RunInfra exige que los argumentos de cada tool call sean un objeto JSON.
//    Cualquier input que no sea un objeto plano se convierte en {}.
//  - Tamaño total: tras lo anterior se estima el cuerpo de los mensajes (bytes UTF-8 del
//    JSON, imágenes incluidas; los argumentos de tool call cuentan doblemente codificados,
//    como van en el cable). Primero se repiten los recortes ya guardados de la sesión. Si aun
//    así pasa de BODY_HIGH se recorta lo más antiguo primero hasta BODY_LOW: 1) salidas de
//    herramientas → primeros HEAD_CHARS caracteres + aviso; 2) si aún no basta, strings largos
//    dentro de los inputs de tool calls (mismas claves, sigue siendo un objeto). Ids y pares
//    tool-call/tool-result quedan intactos. Nunca se tocan los mensajes system, el último
//    mensaje del usuario ni los KEEP_RECENT_MESSAGES últimos mensajes (no "los dos últimos
//    turnos del usuario": en un bucle de agente un solo turno abarca cientos de mensajes y no
//    quedaría nada recortable). Si aun así no cabe, se envía tal cual y se anota en el log.
//  - Las peticiones de título (hook "title") leen el estado pero no lo modifican.
// Depuración: OPENCODE_RUNINFRA_SANITIZE_DEBUG=1 escribe un resumen en /tmp/runinfra-sanitize.log
// (u OPENCODE_RUNINFRA_SANITIZE_LOG): bytes reales del cuerpo HTTP, en qué mensaje y en qué byte
// cambia el prefijo frente a la petición anterior de la sesión, y los tokens en caché de la respuesta.
import { createHash } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"

const PROVIDER = "runinfra"
// Umbrales con histéresis para no romper la caché de prompts de RunInfra
// (https://runinfra.ai/docs/cookbook/prompt-caching.md): cada recorte cambia el prefijo, así que se
// recorta poco a menudo y mucho de una vez en lugar de un poco en cada turno.
const IMAGES_MAX = 8 // límite duro de RunInfra: imágenes por petición, contando todo el historial
const IMAGES_LOW = 4 // al pasar de IMAGES_MAX se descartan las más antiguas hasta dejar estas
const INLINE_HIGH = 2_500_000 // base64 de imágenes en línea que dispara un descarte
const INLINE_LOW = 1_500_000 // ...hasta dejar como mucho esto
// Límite de RunInfra: max_request_bytes = 3_670_016 (GET /models). Fuera de los mensajes van
// el prompt de sistema y los esquemas de herramientas: medido con el hook http.request
// ≈ 62 KB en una sesión aislada (48 KB sistema + 14 KB tools) y ≈ 80 KB estimados en T3 Code
// (18,8k frente a 14,7k tokens en la primera petición). Con 3 MB quedan ~670 KB de margen
// para eso y para el error de la estimación (que en texto sobreestima ~0,3 %).
const BODY_HIGH = 3_000_000 // tamaño estimado de los mensajes que dispara un recorte
const BODY_LOW = 2_000_000 // ...hasta dejarlos en esto, para que los turnos siguientes solo añadan
const KEEP_RECENT_MESSAGES = 10
const HEAD_CHARS = 500
const OUTPUT_NOTE =
  "[salida recortada para respetar el límite de 3.5 MB de RunInfra; vuelve a ejecutar la herramienta si la necesitas]"
const INPUT_NOTE = "[recortado para respetar el límite de 3.5 MB de RunInfra]"
const CAPTION_TIMEOUT_MS = 15_000
const CATALOG_TTL_MS = 24 * 3600 * 1000
const FALLBACK_MODEL = { id: "qwen3-8-27b", effort: "none" }
const CAPTION_PROMPT =
  "Describe esta imagen en español en una sola línea de unas 10 palabras: qué pantalla o vista es, " +
  "el elemento clave visible y su estado. Responde solo con la descripción."
const DEBUG = process.env.OPENCODE_RUNINFRA_SANITIZE_DEBUG === "1"
const LOG = process.env.OPENCODE_RUNINFRA_SANITIZE_LOG || "/tmp/runinfra-sanitize.log"
const debug = (o: unknown) => DEBUG && appendFileSync(LOG, JSON.stringify(o) + "\n")

const ROOT = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "opencode-runinfra")
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" }

const isImage = (mime: unknown) => typeof mime === "string" && mime.startsWith("image/")
const isPlainObject = (x: unknown) => typeof x === "object" && x !== null && !Array.isArray(x)
const readJSON = (file: string) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
}
const writeFile = (file: string, data: string | Buffer) => {
  mkdirSync(join(file, ".."), { recursive: true })
  // Escritura atómica: un index.json a medio escribir perdería la numeración y los recortes.
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, data)
  renameSync(tmp, file)
}

function toObject(input: unknown) {
  if (isPlainObject(input)) return input
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input)
      if (isPlainObject(parsed)) return parsed
    } catch {}
  }
  return {}
}

type Image = {
  key: string // identifica la aparición: "call:<toolCallId>:<j>" o "media:<hash>:<ordinal>"
  hash: string
  mime: string
  data?: string // base64 sin prefijo (undefined si es una URL remota)
  url?: string // URL http(s) de un adjunto remoto
  bytes: number // tamaño en línea (longitud del base64)
  candidates: unknown[] // rutas posibles en disco
  checkSize: boolean // adjuntos: exigir que el archivo en disco tenga el mismo tamaño
  filename?: string // nombre original del adjunto
  replace: (label: string, keep: boolean) => void
  number?: number
  path?: string
  caption?: string
}

// ---------- Modelo de descripciones ----------

type Settings = { baseURL: string; apiKey: string }
let catalog: { at: number; models: Promise<{ id: string; effort?: string }[]> } | undefined

async function captionModel(settings: Settings) {
  if (!catalog || Date.now() - catalog.at > CATALOG_TTL_MS) catalog = { at: Date.now(), models: loadCatalog(settings) }
  const models = await catalog.models.catch((e) => {
    catalog = undefined
    throw e
  })
  const override = process.env.OPENCODE_RUNINFRA_CAPTION_MODEL
  if (override) return models.find((m) => m.id === override) ?? { id: override }
  if (!models.length) throw new Error("ningún modelo de RunInfra acepta imágenes")
  return models[0]
}

async function loadCatalog(settings: Settings) {
  const file = join(ROOT, "caption-models.json")
  const cached = readJSON(file)
  if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.models
  const res = await fetch(`${settings.baseURL}/models`, {
    headers: { authorization: `Bearer ${settings.apiKey}` },
    signal: AbortSignal.timeout(CAPTION_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`GET /models ${res.status}`)
  const all: any[] = (await res.json()).data ?? []
  // Las imágenes se facturan como tokens de entrada (~1500-2000 por captura frente a
  // ~20 de salida), así que se ordena por precio de entrada y luego de salida.
  const models = all.some((m) => Array.isArray(m.input_modalities))
    ? all
        .filter((m) => m.availability === "available" && m.pricing && m.input_modalities?.includes("image"))
        .sort((a, b) => a.pricing.input - b.pricing.input || a.pricing.output - b.pricing.output)
        .map((m) => ({
          id: m.id,
          effort: ["none", "low"].find((e) => m.reasoning_efforts?.includes(e)),
          price: m.pricing,
        }))
    : [FALLBACK_MODEL]
  writeFile(file, JSON.stringify({ at: Date.now(), models }, null, 1))
  return models
}

const inflight = new Map<string, Promise<string>>()

// Devuelve la descripción (cacheada por hash). Cada imagen se envía como mucho una vez:
// tras un intento fallido se guarda una descripción vacía.
function describe(img: Image, settings: Settings | undefined): Promise<string> {
  const file = join(ROOT, "captions", `${img.hash}.txt`)
  if (existsSync(file)) return Promise.resolve(readFileSync(file, "utf8"))
  if (!settings) return Promise.resolve("")
  if (!inflight.has(img.hash)) {
    const run = (async () => {
      const model = await captionModel(settings)
      let caption = ""
      try {
        const res = await fetch(`${settings.baseURL}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${settings.apiKey}` },
          signal: AbortSignal.timeout(CAPTION_TIMEOUT_MS),
          body: JSON.stringify({
            model: model.id,
            max_tokens: 1024,
            ...(model.effort ? { reasoning_effort: model.effort } : {}),
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: CAPTION_PROMPT },
                  { type: "image_url", image_url: { url: img.url ?? `data:${img.mime};base64,${img.data}` } },
                ],
              },
            ],
          }),
        })
        const json: any = await res.json()
        if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(json.error ?? json).slice(0, 200)}`)
        const text = String(json.choices?.[0]?.message?.content ?? "")
        caption = text.replace(/\s+/g, " ").replace(/[[\]·]/g, "").trim().slice(0, 160)
        debug({ at: "caption", model: model.id, effort: model.effort, hash: img.hash, caption, cost: json.usage?.cost })
      } catch (e) {
        debug({ at: "caption-error", model: model.id, hash: img.hash, error: String(e) })
      }
      writeFile(file, caption)
      return caption
    })()
      .catch((e) => (debug({ at: "caption-model-error", error: String(e) }), ""))
      .finally(() => inflight.delete(img.hash))
    inflight.set(img.hash, run)
  }
  return inflight.get(img.hash)!
}

// ---------- Estado por sesión ----------

type ImageRecord = { path?: string; caption?: string; dropped?: true }
type State = {
  hashes: string[] // numeración: imagen N = hashes[N - 1]
  images: Record<string, ImageRecord> // por aparición (Image.key)
  trim: { results: string[]; inputs: string[] } // ids de tool calls con la salida / el input recortados
}

const safeSession = (id: unknown) => String(id ?? "sin-sesion").replace(/[^\w.-]/g, "_")
const stateFile = (session: string) => join(ROOT, session, "index.json")

// Lectura y escritura siempre síncronas y sin await entre medias: los hooks concurrentes de una
// misma sesión no pueden pisarse cambios.
function loadState(session: string): State {
  const raw = readJSON(stateFile(session)) ?? {}
  const list = (x: unknown) => (Array.isArray(x) ? x.filter((v) => typeof v === "string") : [])
  return {
    hashes: list(raw.hashes),
    images: isPlainObject(raw.images) ? raw.images : {},
    trim: { results: list(raw.trim?.results), inputs: list(raw.trim?.inputs) },
  }
}

function saveState(session: string, state: State) {
  try {
    writeFile(stateFile(session), JSON.stringify(state))
  } catch (e) {
    debug({ at: "state-error", session, error: String(e) })
  }
}

// Numera, fija la ruta de cada aparición nueva y decide qué imágenes van en línea.
// Devuelve el registro de cada aparición (en el mismo orden que images).
function decideImages(session: string, images: Image[], persist: boolean) {
  const state = loadState(session)
  const dir = join(ROOT, session)
  let changed = false
  for (const img of images) {
    let n = state.hashes.indexOf(img.hash) + 1
    if (!n) {
      state.hashes.push(img.hash)
      n = state.hashes.length
      changed = true
    }
    img.number = n
  }
  const fresh = new Set(images.filter((img) => !state.images[img.key]).map((img) => img.key))
  const records = images.map((img) => {
    let rec = state.images[img.key]
    if (!rec) {
      rec = state.images[img.key] = { path: resolvePath(img, dir) }
      changed = true
    }
    if (!rec.dropped && img.bytes > INLINE_HIGH) {
      rec.dropped = true // sola ya no cabe
      changed = true
    }
    img.path = rec.path
    return rec
  })
  const sum = (list: number[]) => list.reduce((t, i) => t + images[i].bytes, 0)
  const kept = images.map((_, i) => i).filter((i) => !records[i].dropped)
  if (kept.length > IMAGES_MAX || sum(kept) > INLINE_HIGH) {
    // Lote: se descartan las más antiguas hasta el umbral bajo, sin quitar las nuevas de esta
    // petición mientras quepan en el límite duro.
    const keptFresh = kept.filter((i) => fresh.has(images[i].key))
    const maxCount = Math.min(IMAGES_MAX, Math.max(IMAGES_LOW, keptFresh.length))
    const maxBytes = Math.min(INLINE_HIGH, Math.max(INLINE_LOW, sum(keptFresh)))
    while (kept.length && (kept.length > maxCount || sum(kept) > maxBytes)) records[kept.shift()!].dropped = true
    changed = true
  }
  if (changed && persist) saveState(session, state)
  return records
}

// Guarda la descripción de cada aparición la primera vez (la etiqueta ya no cambia después).
function freezeCaptions(session: string, images: Image[], records: ImageRecord[], captions: Map<string, string>) {
  images.forEach((img, i) => (records[i].caption ??= captions.get(img.hash) ?? ""))
  const state = loadState(session)
  let changed = false
  images.forEach((img, i) => {
    const rec = state.images[img.key]
    if (rec && rec.caption === undefined) {
      rec.caption = records[i].caption
      changed = true
    }
  })
  if (changed) saveState(session, state)
}

function resolvePath(img: Image, dir: string) {
  for (const p of img.candidates) {
    if (typeof p !== "string" || !isAbsolute(p)) continue
    try {
      // Solo si el archivo en disco tiene el mismo tamaño que la imagen enviada.
      if (!img.checkSize ? existsSync(p) : statSync(p).size === Buffer.byteLength(img.data ?? "", "base64")) return p
    } catch {}
  }
  if (img.url) return img.url
  const file = join(dir, `imagen-${String(img.number).padStart(2, "0")}.${EXT[img.mime] ?? "img"}`)
  try {
    if (!existsSync(file)) writeFile(file, Buffer.from(img.data!, "base64"))
    return file
  } catch {
    return undefined
  }
}

// ---------- Recorrido de los mensajes ----------

function imageData(uri: unknown) {
  if (typeof uri !== "string") return {}
  const m = /^data:[^;,]*;base64,(.*)$/s.exec(uri)
  return m ? { data: m[1] } : { url: uri }
}
const hashOf = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 24)
const text = (t: string) => ({ type: "text", text: t })

function collect(messages: any[]) {
  const images: Image[] = []
  const callPaths = new Map<string, unknown>()
  // Ordinal de cada hash entre las apariciones sin tool call (adjuntos, resultados sin id).
  const seen = new Map<string, number>()
  const ordinalKey = (kind: string, hash: string) => {
    const n = (seen.get(`${kind}:${hash}`) ?? 0) + 1
    seen.set(`${kind}:${hash}`, n)
    return `${kind}:${hash}:${n}`
  }
  let toolInputsFixed = 0
  // Las inserciones se aplican al final, sobre copias de las partes (no se toca el historial guardado).
  const edits = new Map<any[], Map<number, any[]>>()
  const edit = (arr: any[], i: number, items: any[]) => {
    if (!edits.has(arr)) edits.set(arr, new Map())
    edits.get(arr)!.set(i, items)
  }

  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    const content = message.content
    content.forEach((part: any, i: number) => {
      if (part.type === "tool-call") {
        if (!isPlainObject(part.input)) {
          content[i] = { ...part, input: toObject(part.input) }
          toolInputsFixed++
        }
        callPaths.set(part.id ?? part.toolCallId, content[i].input?.filePath ?? content[i].input?.path)
      } else if (part.type === "media" && isImage(part.media?.source?.mediaType ?? part.media?.mediaType)) {
        const src = part.media.source ?? {}
        const { data, url } = src.data ? { data: src.data as string, url: undefined } : imageData(src.url)
        if (!data && !url) return
        const hash = hashOf(data ?? url!)
        images.push({
          key: ordinalKey("media", hash),
          hash,
          mime: src.mediaType ?? part.media.mediaType,
          data,
          url,
          bytes: (data ?? url!).length,
          candidates: [part.filename],
          checkSize: true,
          filename: typeof part.filename === "string" && part.filename !== "clipboard" ? part.filename : undefined,
          replace: (label, keep) => edit(content, i, keep ? [text(label), part] : [text(label)]),
        })
      } else if (part.type === "tool-result" && part.result?.type === "content" && Array.isArray(part.result.value)) {
        part.result.value.forEach((item: any, j: number) => {
          if (item.type !== "file" || !isImage(item.mime)) return
          const { data, url } = imageData(item.uri ?? item.url)
          if (!data && !url) return
          const hash = hashOf(data ?? url!)
          const id = part.id ?? part.toolCallId
          images.push({
            key: typeof id === "string" && id ? `call:${id}:${j}` : ordinalKey("result", hash),
            hash,
            mime: item.mime,
            data,
            url,
            bytes: (data ?? url!).length,
            candidates: [item.name, callPaths.get(part.id ?? part.toolCallId)],
            checkSize: false,
            replace: (label, keep) => edit(part.result.value, j, keep ? [text(label), item] : [text(label)]),
          })
        })
      }
    })
  }

  const apply = () => {
    for (const message of messages) {
      if (!Array.isArray(message.content)) continue
      const splice = (arr: any[]) => arr.flatMap((x, k) => edits.get(arr)?.get(k) ?? [x])
      message.content = splice(message.content).map((part: any) =>
        part.type === "tool-result" && edits.has(part.result?.value)
          ? { ...part, result: { ...part.result, value: splice(part.result.value) } }
          : part,
      )
    }
  }
  return { images, apply, toolInputsFixed }
}

// ---------- Tamaño total de la petición ----------

const bytes = (x: unknown) => Buffer.byteLength(JSON.stringify(x) ?? "")
// En el cable los argumentos de un tool call son un string JSON dentro del JSON: se cuenta así.
const partBytes = (part: any) =>
  part.type === "tool-call" ? bytes({ ...part, input: JSON.stringify(part.input ?? {}) }) : bytes(part)

function head(s: string, note: string) {
  if (s.length <= HEAD_CHARS + note.length + 2) return s
  let end = HEAD_CHARS
  if (/[\uD800-\uDBFF]/.test(s[end - 1])) end-- // no partir un par sustituto
  return `${s.slice(0, end)}…\n${note}`
}

// Copia recortada de un tool-result (o el mismo objeto si no hay nada que recortar).
function shrinkResult(part: any) {
  const r = part.result
  let result = r
  if ((r?.type === "text" || r?.type === "error-text") && typeof r.value === "string") {
    result = { ...r, value: head(r.value, OUTPUT_NOTE) }
  } else if ((r?.type === "json" || r?.type === "error-json") && bytes(r.value) > HEAD_CHARS * 2) {
    result = { type: r.type === "json" ? "text" : "error-text", value: head(JSON.stringify(r.value), OUTPUT_NOTE) }
  } else if (r?.type === "content" && Array.isArray(r.value)) {
    const value = r.value.map((item: any) =>
      item?.type === "text" && typeof item.text === "string"
        ? { ...item, text: head(item.text, OUTPUT_NOTE) }
        : item?.type === "file" && !isImage(item.mime) && bytes(item) > HEAD_CHARS * 2
          ? text(`[archivo ${item.name ?? item.mime} omitido · ${OUTPUT_NOTE}]`)
          : item,
    )
    if (value.some((item: any, j: number) => item !== r.value[j])) result = { ...r, value }
  }
  return result === r || bytes(result) >= bytes(r) ? part : { ...part, result }
}

// Copia de un tool-call con los strings largos de su input recortados (mismas claves).
function shrinkInput(part: any) {
  const shorten = (x: any): any =>
    typeof x === "string"
      ? head(x, INPUT_NOTE)
      : Array.isArray(x)
        ? x.map(shorten)
        : isPlainObject(x)
          ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, shorten(v)]))
          : x
  if (!isPlainObject(part.input)) return part
  const input = shorten(part.input)
  return bytes(input) < bytes(part.input) ? { ...part, input } : part
}

const idOf = (part: any) => {
  const id = part.id ?? part.toolCallId
  return typeof id === "string" && id ? id : undefined
}

function estimate(messages: any[]) {
  let total = bytes(messages)
  for (const m of messages)
    if (Array.isArray(m.content))
      for (const part of m.content) if (part.type === "tool-call") total += partBytes(part) - bytes(part)
  return total
}

function fitBudget(hook: string, event: { sessionID?: string; messages: any[] }) {
  const messages = event.messages
  const session = safeSession(event.sessionID)
  const lastUser = messages.findLastIndex((m) => m.role === "user")
  const protectFrom = messages.length - KEEP_RECENT_MESSAGES
  const trimmable = (i: number) =>
    i < protectFrom && i !== lastUser && messages[i].role !== "system" && Array.isArray(messages[i].content)
  const state = loadState(session)
  const shrinkers = [
    ["tool-result", shrinkResult, state.trim.results],
    ["tool-call", shrinkInput, state.trim.inputs],
  ] as const
  // Recorta las partes de un tipo que cumplan want(); solo copia el array si cambia algo.
  const shrinkMessage = (
    i: number,
    type: string,
    shrink: (p: any) => any,
    want: (p: any) => boolean,
    onShrunk?: (part: any, saved: number) => void,
  ) => {
    let count = 0
    const content = messages[i].content.map((part: any) => {
      if (part.type !== type || !want(part)) return part
      const next = shrink(part)
      if (next === part) return part
      count++
      onShrunk?.(part, partBytes(part) - partBytes(next))
      return next
    })
    if (count) messages[i].content = content
    return count
  }

  // 1) Repetir los recortes ya decididos: shrink* son deterministas, así que los bytes son los
  //    mismos que en las peticiones anteriores y el prefijo en caché sigue valiendo.
  let reapplied = 0
  for (const [type, shrink, ids] of shrinkers) {
    if (!ids.length) continue
    const set = new Set(ids)
    for (let i = 0; i < messages.length; i++)
      if (trimmable(i)) reapplied += shrinkMessage(i, type, shrink, (p) => set.has(idOf(p)!))
  }
  let total = estimate(messages)
  if (total <= BODY_HIGH) {
    if (reapplied) debug({ at: "budget", hook, session: event.sessionID, reapplied, after: total, batch: false })
    return
  }

  // 2) Nuevo lote: lo más antiguo primero hasta BODY_LOW; los ids recortados se guardan.
  const before = total
  const trimmed = { "tool-result": 0, "tool-call": 0 }
  for (const [type, shrink, ids] of shrinkers) {
    for (let i = 0; i < messages.length && total > BODY_LOW; i++) {
      if (!trimmable(i)) continue
      trimmed[type] += shrinkMessage(
        i,
        type,
        shrink,
        () => total > BODY_LOW,
        (part, saved) => {
          total -= saved
          const id = idOf(part)
          if (id && !ids.includes(id)) ids.push(id)
        },
      )
    }
  }
  total = estimate(messages)
  if (hook !== "title" && (trimmed["tool-result"] || trimmed["tool-call"])) saveState(session, state)
  debug({
    at: "budget",
    hook,
    session: event.sessionID,
    batch: true,
    before,
    after: total,
    fits: total <= BODY_HIGH,
    reapplied,
    results: trimmed["tool-result"],
    inputs: trimmed["tool-call"],
    messages: messages.length,
    protectFrom: Math.max(0, protectFrom),
  })
}

async function getSettings(ctx: any): Promise<Settings | undefined> {
  try {
    const s = (await ctx.provider.get({ providerID: PROVIDER }))?.data?.settings
    if (s?.baseURL && s?.apiKey) return { baseURL: String(s.baseURL).replace(/\/+$/, ""), apiKey: s.apiKey }
  } catch {}
  return undefined
}

async function sanitize(ctx: any, hook: string, event: { sessionID?: string; messages: any[] }) {
  const { images, apply, toolInputsFixed } = collect(event.messages)
  if (!images.length) return void (toolInputsFixed && debug({ at: "tool-inputs", hook, toolInputsFixed }))
  const session = safeSession(event.sessionID)
  // Bloque síncrono: numeración, rutas y descartes se leen y se guardan sin await entre medias.
  const records = decideImages(session, images, hook !== "title")
  // Descripciones solo de apariciones nuevas, en paralelo; nunca rompen la petición.
  const pending = [...new Map(images.filter((_, i) => records[i].caption === undefined).map((img) => [img.hash, img])).values()]
  const needsCaption = pending.some((img) => !existsSync(join(ROOT, "captions", `${img.hash}.txt`)))
  const settings = needsCaption ? await getSettings(ctx) : undefined
  const captions = new Map(
    await Promise.all(pending.map(async (img) => [img.hash, await describe(img, settings).catch(() => "")] as const)),
  )
  if (hook !== "title") freezeCaptions(session, images, records, captions)
  images.forEach((img, i) => {
    const keep = !records[i].dropped
    const fields = [
      img.number ? `imagen ${img.number}${keep ? "" : " omitida"}` : keep ? "imagen" : "imagen omitida",
      img.filename && img.path !== img.filename ? `${img.path} (adjunto ${img.filename})` : img.path,
      records[i].caption ?? captions.get(img.hash),
      keep ? undefined : "vuelve a leer ese archivo con read si la necesitas",
    ]
    img.replace(`[${fields.filter(Boolean).join(" · ")}]`, keep)
  })
  apply()
  const kept = images.filter((_, i) => !records[i].dropped)
  debug({
    at: "images",
    hook,
    session: event.sessionID,
    images: images.length,
    kept: kept.length,
    dropped: images.length - kept.length,
    keptBytes: kept.reduce((t, img) => t + img.bytes, 0),
    totalBytes: images.reduce((t, img) => t + img.bytes, 0),
    labels: images.map((img, i) => `${img.number}${records[i].dropped ? "x" : ""}`).join(","),
    toolInputsFixed,
  })
}

// ---------- Depuración: ¿se mantiene el prefijo? ----------

// Cada `opencode run` es un proceso nuevo, así que lo anterior se guarda junto al estado de la sesión.
function debugPrefix(hook: string, sessionID: unknown, messages: any[]) {
  const file = join(ROOT, safeSession(sessionID), `debug-prefix-${hook}.json`)
  const hashes = messages.map((m) => hashOf(JSON.stringify(m)))
  const previous: string[] = readJSON(file) ?? []
  let same = 0
  while (same < previous.length && same < hashes.length && previous[same] === hashes[same]) same++
  debug({
    at: "prefix",
    hook,
    session: sessionID,
    messages: hashes.length,
    previous: previous.length,
    // null: los mensajes de la petición anterior siguen intactos y en el mismo orden.
    firstChanged: same < previous.length ? same : null,
  })
  writeFile(file, JSON.stringify(hashes))
}

function commonPrefixBytes(a: string, b: string) {
  let i = 0
  const n = Math.min(a.length, b.length)
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++
  return Buffer.byteLength(a.slice(0, i))
}

// Último objeto usage de una respuesta (SSE de streaming o JSON).
function lastUsage(body: string) {
  const lines = body.split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.startsWith("data:") || !line.includes('"usage"')) continue
    try {
      const usage = JSON.parse(line.slice(5)).usage
      if (usage) return usage
    } catch {}
  }
  try {
    return JSON.parse(body).usage
  } catch {
    return undefined
  }
}

export default {
  id: "runinfra-sanitize",
  async setup(ctx: any) {
    const hook = (name: string) => async (event: any) => {
      try {
        await sanitize(ctx, name, event)
      } catch (e) {
        debug({ at: "sanitize-error", hook: name, error: String(e) })
      }
      try {
        fitBudget(name, event)
      } catch (e) {
        debug({ at: "budget-error", hook: name, error: String(e) })
      }
      if (DEBUG)
        try {
          debugPrefix(name, event.sessionID, event.messages)
        } catch (e) {
          debug({ at: "prefix-error", hook: name, error: String(e) })
        }
    }
    for (const name of ["context", "compaction", "generate", "title"]) {
      await ctx.session.hook(name, hook(name), { providerID: PROVIDER })
    }
    if (DEBUG) {
      // Solo depuración: bytes (UTF-8) e imágenes del cuerpo HTTP real y cuántos bytes iniciales
      // coinciden con la petición anterior de la misma sesión, modelo y tipo (kind: título o no).
      await ctx.session.hook(
        "http.request",
        async (e: any) => {
          const body = await e.request.clone().text()
          const session = e.sessionID
          let prefixBytes: number | undefined
          if (session) {
            const file = join(ROOT, safeSession(session), `debug-body-${safeSession(`${e.kind}-${e.model?.id}`)}.txt`)
            if (existsSync(file)) prefixBytes = commonPrefixBytes(readFileSync(file, "utf8"), body)
            writeFile(file, body)
          }
          debug({
            at: "wire",
            session,
            kind: e.kind,
            model: e.model?.id,
            bytes: Buffer.byteLength(body),
            prefixBytes,
            image_url: (body.match(/"type":"image_url"/g) ?? []).length,
          })
        },
        { providerID: PROVIDER },
      )
      // Tokens en caché que informa RunInfra. La copia se lee en segundo plano: no frena el stream.
      await ctx.session.hook(
        "http.response",
        async (e: any) => {
          const res: Response | undefined = e.response
          if (!res?.body) return
          void res
            .clone()
            .text()
            .then((body) => {
              const usage = lastUsage(body)
              debug({
                at: "usage",
                session: e.sessionID,
                kind: e.kind,
                model: e.model?.id,
                status: res.status,
                prompt_tokens: usage?.prompt_tokens,
                cached_tokens: usage?.prompt_tokens_details?.cached_tokens,
                runinfra_cached_input_tokens: usage?.runinfra?.cached_input_tokens,
              })
            })
            .catch((err) => debug({ at: "usage-error", error: String(err) }))
        },
        { providerID: PROVIDER },
      )
    }
  },
}
