// Sanea los mensajes que opencode (v2) envía al proveedor "runinfra".
//  - Límites de RunInfra: máx. 8 imágenes por petición (cuenta todo el historial) y
//    cuerpo de petición de máx. 3,5 MB. Se conservan como mucho las KEEP_IMAGES
//    imágenes más recientes y, además, se descartan las más antiguas hasta que el
//    base64 en línea sume menos de BUDGET_BYTES (una imagen que sola no cabe también
//    se descarta). Las partes no se borran: los pares tool-call/tool-result quedan intactos.
//  - Etiquetas estables: cada imagen recibe un número por orden de primera aparición
//    (registro persistente por sesión, sobrevive a la compactación). Antes de cada
//    imagen conservada va "[imagen N · ruta · descripción]"; cada imagen descartada se
//    sustituye por "[imagen N omitida · ruta · descripción · vuelve a leer ...]".
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
//    como van en el cable). Si pasa de BODY_BUDGET se recorta lo más antiguo primero:
//    1) salidas de herramientas → primeros HEAD_CHARS caracteres + aviso; 2) si aún no
//    cabe, strings largos dentro de los inputs de tool calls (mismas claves, sigue siendo
//    un objeto). Ids y pares tool-call/tool-result quedan intactos. Nunca se tocan los
//    mensajes system, el último mensaje del usuario ni los KEEP_RECENT_MESSAGES últimos
//    mensajes (no "los dos últimos turnos del usuario": en un bucle de agente un solo turno
//    abarca cientos de mensajes y no quedaría nada recortable). Si aun así no cabe, se
//    envía tal cual y se anota en el log de depuración.
// Depuración: OPENCODE_RUNINFRA_SANITIZE_DEBUG=1 escribe un resumen en /tmp/runinfra-sanitize.log
// (incluidos los bytes reales del cuerpo HTTP de cada petición).
import { createHash } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"

const PROVIDER = "runinfra"
const KEEP_IMAGES = 6
const BUDGET_BYTES = 2_500_000
// Límite de RunInfra: max_request_bytes = 3_670_016 (GET /models). Fuera de los mensajes van
// el prompt de sistema y los esquemas de herramientas: medido con el hook http.request
// ≈ 62 KB en una sesión aislada (48 KB sistema + 14 KB tools) y ≈ 80 KB estimados en T3 Code
// (18,8k frente a 14,7k tokens en la primera petición). Con 3 MB quedan ~670 KB de margen
// para eso y para el error de la estimación (que en texto sobreestima ~0,3 %).
const BODY_BUDGET = 3_000_000
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
const debug = (o: unknown) => DEBUG && appendFileSync("/tmp/runinfra-sanitize.log", JSON.stringify(o) + "\n")

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
  writeFileSync(file, data)
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

// ---------- Numeración y rutas ----------

function assignNumbers(sessionID: string, images: Image[]) {
  const dir = join(ROOT, sessionID)
  const file = join(dir, "index.json")
  const hashes: string[] = readJSON(file)?.hashes ?? []
  let changed = false
  for (const img of images) {
    let n = hashes.indexOf(img.hash) + 1
    if (!n) {
      hashes.push(img.hash)
      n = hashes.length
      changed = true
    }
    img.number = n
    img.path = resolvePath(img, dir)
  }
  if (changed) writeFile(file, JSON.stringify({ hashes }))
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
        images.push({
          hash: hashOf(data ?? url!),
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
          images.push({
            hash: hashOf(data ?? url!),
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

// Índices de las imágenes que se mantienen en línea: las KEEP_IMAGES más recientes,
// sin las que solas exceden el presupuesto, y quitando las más antiguas hasta caber.
function chooseKept(images: Image[]) {
  let kept = images.map((_, i) => i).slice(-KEEP_IMAGES).filter((i) => images[i].bytes <= BUDGET_BYTES)
  const total = () => kept.reduce((s, i) => s + images[i].bytes, 0)
  while (kept.length && total() > BUDGET_BYTES) kept.shift()
  return new Set(kept)
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

function fitBudget(hook: string, event: { sessionID?: string; messages: any[] }) {
  const messages = event.messages
  let total = bytes(messages)
  for (const m of messages)
    if (Array.isArray(m.content))
      for (const part of m.content) if (part.type === "tool-call") total += partBytes(part) - bytes(part)
  if (total <= BODY_BUDGET) return
  const before = total
  const lastUser = messages.findLastIndex((m) => m.role === "user")
  const protectFrom = messages.length - KEEP_RECENT_MESSAGES
  const trimmed = { "tool-result": 0, "tool-call": 0 }
  for (const [type, shrink] of [
    ["tool-result", shrinkResult],
    ["tool-call", shrinkInput],
  ] as const) {
    for (let i = 0; i < protectFrom && total > BODY_BUDGET; i++) {
      const message = messages[i]
      if (message.role === "system" || i === lastUser || !Array.isArray(message.content)) continue
      if (!message.content.some((part: any) => part.type === type)) continue
      message.content = message.content.map((part: any) => {
        if (total <= BODY_BUDGET || part.type !== type) return part
        const next = shrink(part)
        if (next === part) return part
        total -= partBytes(part) - partBytes(next)
        trimmed[type]++
        return next
      })
    }
  }
  debug({
    at: "budget",
    hook,
    session: event.sessionID,
    before,
    after: total,
    fits: total <= BODY_BUDGET,
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

async function sanitize(ctx: any, event: { sessionID?: string; messages: any[] }) {
  const { images, apply, toolInputsFixed } = collect(event.messages)
  if (!images.length) return void (toolInputsFixed && debug({ at: new Date().toISOString(), toolInputsFixed }))
  const sessionID = (event.sessionID ?? "sin-sesion").replace(/[^\w.-]/g, "_")
  try {
    assignNumbers(sessionID, images)
  } catch (e) {
    debug({ at: "index-error", error: String(e) })
  }
  const kept = chooseKept(images)
  // Descripciones solo de imágenes nuevas, en paralelo; nunca rompen la petición.
  const unique = [...new Map(images.map((img) => [img.hash, img])).values()]
  const needsCaption = unique.some((img) => !existsSync(join(ROOT, "captions", `${img.hash}.txt`)))
  const settings = needsCaption ? await getSettings(ctx) : undefined
  const captions = new Map(
    await Promise.all(unique.map(async (img) => [img.hash, await describe(img, settings).catch(() => "")] as const)),
  )
  images.forEach((img, i) => {
    const keep = kept.has(i)
    const fields = [
      img.number ? `imagen ${img.number}${keep ? "" : " omitida"}` : keep ? "imagen" : "imagen omitida",
      img.filename && img.path !== img.filename ? `${img.path} (adjunto ${img.filename})` : img.path,
      captions.get(img.hash),
      keep ? undefined : "vuelve a leer ese archivo con read si la necesitas",
    ]
    img.replace(`[${fields.filter(Boolean).join(" · ")}]`, keep)
  })
  apply()
  debug({
    at: new Date().toISOString(),
    session: event.sessionID,
    images: images.length,
    kept: kept.size,
    dropped: images.length - kept.size,
    keptBytes: [...kept].reduce((s, i) => s + images[i].bytes, 0),
    totalBytes: images.reduce((s, img) => s + img.bytes, 0),
    labels: images.map((img, i) => `${img.number}${kept.has(i) ? "" : "x"}`).join(","),
    toolInputsFixed,
  })
}

export default {
  id: "runinfra-sanitize",
  async setup(ctx: any) {
    const hook = (name: string) => async (event: any) => {
      try {
        await sanitize(ctx, event)
      } catch (e) {
        debug({ at: "sanitize-error", error: String(e) })
      }
      try {
        fitBudget(name, event)
      } catch (e) {
        debug({ at: "budget-error", error: String(e) })
      }
    }
    for (const name of ["context", "compaction", "generate", "title"]) {
      await ctx.session.hook(name, hook(name), { providerID: PROVIDER })
    }
    if (DEBUG) {
      // Solo depuración: cuántas imágenes y bytes (UTF-8) salen realmente en el cuerpo HTTP.
      await ctx.session.hook(
        "http.request",
        async (e: any) => {
          const body = await e.request.clone().text()
          debug({
            at: "wire",
            model: e.model?.id,
            bytes: Buffer.byteLength(body),
            image_url: (body.match(/"type":"image_url"/g) ?? []).length,
          })
        },
        { providerID: PROVIDER },
      )
    }
  },
}
