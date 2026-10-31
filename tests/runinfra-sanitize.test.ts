// Pruebas rápidas de plugins/runinfra-sanitize.ts con mensajes falsos (sin red ni opencode).
// Ejecutar:  bun test
// Otra copia del plugin:  RUNINFRA_SANITIZE_PLUGIN=/ruta/al/plugin.ts bun test
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const PLUGIN = process.env.RUNINFRA_SANITIZE_PLUGIN ?? join(import.meta.dir, "../plugins/runinfra-sanitize.ts")
const BUDGET = 3_000_000 // BODY_HIGH
const BODY_LOW = 2_000_000
const OUTPUT_NOTE = "[salida recortada para respetar el límite de 3.5 MB de RunInfra"
const INPUT_NOTE = "[recortado para respetar el límite de 3.5 MB de RunInfra]"

const cache = mkdtempSync(join(tmpdir(), "runinfra-sanitize-test-"))
const hooks = new Map<string, (e: any) => Promise<void>>()

beforeAll(async () => {
  // ROOT se calcula al importar: la caché (índices, copias de imágenes) va a un directorio temporal.
  process.env.XDG_CACHE_HOME = cache
  delete process.env.OPENCODE_RUNINFRA_SANITIZE_DEBUG
  const plugin = (await import(PLUGIN)).default
  await plugin.setup({
    session: { hook: async (name: string, cb: any) => void hooks.set(name, cb) },
    provider: { get: async () => undefined }, // sin ajustes: no se piden descripciones
  })
})
afterAll(() => rmSync(cache, { recursive: true, force: true }))

let sessions = 0
async function run(messages: any[], hook = "context", sessionID = `ses_test_${++sessions}`) {
  const event = { sessionID, messages }
  await hooks.get(hook)!(event)
  return event.messages
}

// Estimación independiente del cuerpo: bytes UTF-8 y argumentos de tool call doblemente codificados.
function wireBytes(messages: any[]) {
  let total = Buffer.byteLength(JSON.stringify(messages))
  for (const m of messages)
    if (Array.isArray(m.content))
      for (const p of m.content)
        if (p.type === "tool-call")
          total += Buffer.byteLength(JSON.stringify(JSON.stringify(p.input))) - Buffer.byteLength(JSON.stringify(p.input))
  return total
}

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], metadata: {} })
const call = (id: string, name: string, input: unknown) => ({
  role: "assistant",
  content: [{ type: "reasoning", text: "pienso" }, { type: "tool-call", id, name, input, providerExecuted: false }],
})
const result = (id: string, name: string, result: any) => ({
  role: "tool",
  content: [{ type: "tool-result", id, name, result, providerExecuted: false }],
})
const big = (n: number, tag: string) => `${tag} línea ñ "comillas"\n`.repeat(Math.ceil(n / (tag.length + 24))).slice(0, n)

// Historial de ~4,1 MB: 40 lecturas de ~100 KB y al final un turno reciente también grande.
function history() {
  const msgs: any[] = [{ role: "system", content: "x".repeat(50_000) }, user("empieza")]
  for (let i = 0; i < 40; i++) {
    msgs.push(call(`call_${i}`, "read", { path: `/tmp/f${i}.txt` }))
    msgs.push(result(`call_${i}`, "read", { type: "text", value: big(100_000, `f${i}`) }))
  }
  msgs.push(user("sigue"))
  for (let i = 40; i < 44; i++) {
    msgs.push(call(`call_${i}`, "shell", { command: `cat f${i}.txt` }))
    msgs.push(result(`call_${i}`, "shell", { type: "text", value: big(100_000, `f${i}`) }))
  }
  return msgs
}

// Los mensajes de la petición anterior siguen idénticos byte a byte (solo se añadió al final).
function expectPrefix(prev: any[], next: any[]) {
  expect(next.length).toBeGreaterThanOrEqual(prev.length)
  for (let i = 0; i < prev.length; i++) expect(JSON.stringify(next[i])).toBe(JSON.stringify(prev[i]))
}
const firstChanged = (prev: any[], next: any[]) => prev.findIndex((m, i) => JSON.stringify(m) !== JSON.stringify(next[i]))

const pairs = (messages: any[]) =>
  messages.flatMap((m) =>
    Array.isArray(m.content)
      ? m.content.filter((p: any) => p.type === "tool-call" || p.type === "tool-result").map((p: any) => `${p.type}:${p.id}`)
      : [],
  )

describe("presupuesto de tamaño", () => {
  test("registra los cuatro hooks", () => {
    for (const name of ["context", "compaction", "generate", "title"]) expect(hooks.has(name)).toBe(true)
  })

  test("por debajo del presupuesto no toca nada (idéntico byte a byte)", async () => {
    const msgs = history().slice(0, 30)
    const before = JSON.stringify(msgs)
    const contents = msgs.map((m) => m.content)
    expect(wireBytes(msgs)).toBeLessThan(BUDGET)
    const out = await run(msgs)
    expect(JSON.stringify(out)).toBe(before)
    out.forEach((m, i) => expect(m.content).toBe(contents[i]))
  })

  for (const hook of ["context", "compaction", "generate", "title"]) {
    test(`[${hook}] recorta las salidas más antiguas hasta caber`, async () => {
      const msgs = history()
      const original = msgs.map((m) => m.content)
      const snapshot = JSON.stringify(msgs)
      const ids = pairs(msgs)
      expect(wireBytes(msgs)).toBeGreaterThan(3_670_016)

      const out = await run(msgs, hook)
      expect(wireBytes(out)).toBeLessThanOrEqual(BUDGET)
      // Las partes originales no se mutan (copy-on-write).
      expect(JSON.stringify(original.map((content, i) => ({ ...msgs[i], content })))).toBe(snapshot)
      // Pares e ids intactos y en el mismo orden.
      expect(pairs(out)).toEqual(ids)
      // Lo recortado es un prefijo (lo más antiguo) y conserva el principio + el aviso.
      const results = out.filter((m) => m.role === "tool").map((m) => m.content[0])
      const cut = results.map((p) => p.result.value.includes(OUTPUT_NOTE))
      const firstKept = cut.indexOf(false)
      expect(firstKept).toBeGreaterThan(0)
      expect(cut.slice(firstKept).every((c) => !c)).toBe(true)
      expect(results[0].result.type).toBe("text")
      expect(results[0].result.value.startsWith(big(500, "f0"))).toBe(true)
      expect(results[0].result.value.length).toBeLessThan(700)
      // Los inputs no hacían falta tocarlos.
      out.forEach((m, i) => m.role === "assistant" && expect(m.content).toBe(original[i]))
      // Mensajes protegidos: system, último usuario y los 10 últimos, mismos objetos.
      expect(out[0].content).toBe(original[0])
      const lastUser = out.findLastIndex((m) => m.role === "user")
      expect(out[lastUser].content).toBe(original[lastUser])
      for (let i = out.length - 10; i < out.length; i++) expect(out[i].content).toBe(original[i])
    })
  }

  test("si las salidas no bastan, recorta strings largos de inputs antiguos (siguen siendo objetos)", async () => {
    const msgs: any[] = [user("escribe")]
    for (let i = 0; i < 20; i++) {
      msgs.push(call(`w${i}`, "write", { filePath: `/tmp/w${i}.ts`, content: big(200_000, `w${i}`), opts: { note: big(5_000, "n") } }))
      msgs.push(result(`w${i}`, "write", { type: "text", value: "Wrote file successfully." }))
    }
    msgs.push(user("ahora"))
    const original = msgs.map((m) => m.content)
    const snapshot = JSON.stringify(msgs)
    const ids = pairs(msgs)
    const out = await run(msgs)
    expect(wireBytes(out)).toBeLessThanOrEqual(BUDGET)
    expect(pairs(out)).toEqual(ids)
    const calls = out.filter((m) => m.role === "assistant").map((m) => m.content[1])
    for (const c of calls) {
      expect(c.input).toBeObject()
      expect(Array.isArray(c.input)).toBe(false)
      expect(Object.keys(c.input)).toEqual(["filePath", "content", "opts"])
      expect(c.input.filePath).toMatch(/^\/tmp\/w\d+\.ts$/)
    }
    expect(calls[0].input.content).toContain(INPUT_NOTE)
    expect(calls[0].input.opts.note).toContain(INPUT_NOTE)
    expect(calls.at(-1).input.content).not.toContain(INPUT_NOTE)
    // Salidas cortas intactas.
    for (const m of out.filter((m) => m.role === "tool")) expect(m.content[0].result.value).toBe("Wrote file successfully.")
    // Las partes originales no se mutan.
    expect(JSON.stringify(original.map((content, i) => ({ ...msgs[i], content })))).toBe(snapshot)
  })

  test("si lo protegido ya no cabe, lo deja tal cual", async () => {
    const msgs: any[] = [user("hola")]
    for (let i = 0; i < 4; i++) {
      msgs.push(call(`c${i}`, "read", { path: `/f${i}` }))
      msgs.push(result(`c${i}`, "read", { type: "text", value: big(1_000_000, `p${i}`) }))
    }
    const before = JSON.stringify(msgs)
    const out = await run(msgs)
    expect(JSON.stringify(out)).toBe(before)
  })

  test("otros tipos de resultado: content, json y error-text", async () => {
    const png = Buffer.from("png").toString("base64")
    const msgs: any[] = [
      user("varios"),
      call("a", "read", { path: "/a" }),
      result("a", "read", {
        type: "content",
        value: [
          { type: "text", text: big(900_000, "a") },
          { type: "file", mime: "application/pdf", uri: `data:application/pdf;base64,${"Q".repeat(900_000)}` },
          { type: "file", mime: "image/png", uri: `data:image/png;base64,${png}` },
        ],
      }),
      call("b", "mcp", {}),
      result("b", "mcp", { type: "json", value: { rows: Array.from({ length: 20_000 }, (_, i) => ({ i, v: "valor" })) } }),
      call("c", "shell", { command: "x" }),
      result("c", "shell", { type: "error-text", value: big(900_000, "c") }),
      ...Array.from({ length: 10 }, (_, i) => user(big(250_000, `u${i}`))),
    ]
    const out = await run(msgs)
    expect(wireBytes(out)).toBeLessThanOrEqual(BUDGET)
    const [a, b, c] = [2, 4, 6].map((i) => out[i].content[0].result)
    expect(a.type).toBe("content")
    expect(a.value[0].text).toContain(OUTPUT_NOTE)
    expect(a.value[1]).toEqual({ type: "text", text: expect.stringContaining("omitido") })
    expect(a.value.some((v: any) => v.type === "file" && v.mime === "image/png")).toBe(true)
    expect(b.type).toBe("text")
    expect(b.value.startsWith('{"rows":[{"i":0')).toBe(true)
    expect(b.value).toContain(OUTPUT_NOTE)
    expect(c.type).toBe("error-text")
    expect(c.value).toContain(OUTPUT_NOTE)
    expect(pairs(out)).toEqual(["tool-call:a", "tool-result:a", "tool-call:b", "tool-result:b", "tool-call:c", "tool-result:c"])
  })
})

describe("caché de prompts: recorte por lotes", () => {
  // Sesión que crece de dos en dos mensajes (lectura de ~100 KB); objetos nuevos en cada
  // petición, como hace opencode al reconstruir el historial guardado.
  const growing = (reads: number) => {
    const msgs: any[] = [{ role: "system", content: "x".repeat(50_000) }, user("empieza")]
    for (let i = 0; i < reads; i++) {
      msgs.push(call(`g${i}`, "read", { path: `/tmp/g${i}.txt` }))
      msgs.push(result(`g${i}`, "read", { type: "text", value: big(100_000, `g${i}`) }))
    }
    return msgs
  }
  const cutCount = (out: any[]) => out.filter((m) => m.role === "tool" && m.content[0].result.value.includes(OUTPUT_NOTE)).length

  test("al pasar de 3,0 MB recorta hasta ≤ 2,0 MB y los turnos siguientes solo añaden", async () => {
    const ses = "ses_body_batch"
    let reads = 25
    let prev = await run(growing(reads), "context", ses)
    expect(cutCount(prev)).toBe(0)
    // Crecer hasta el primer lote.
    while (cutCount(prev) === 0) {
      expect(reads).toBeLessThan(40)
      const next = await run(growing(++reads), "context", ses)
      if (cutCount(next) === 0) expectPrefix(prev, next)
      prev = next
    }
    expect(wireBytes(growing(reads))).toBeGreaterThan(BUDGET)
    expect(cutCount(prev)).toBeGreaterThan(0)
    expect(wireBytes(prev)).toBeLessThanOrEqual(BODY_LOW)
    const cut = cutCount(prev)
    // Los siguientes turnos (hasta volver a 3,0 MB) no recortan más: prefijo idéntico byte a byte.
    let turns = 0
    for (;;) {
      expect(turns).toBeLessThan(30)
      const next = await run(growing(++reads), "context", ses)
      if (cutCount(next) > cut) {
        // Segundo lote: lo ya recortado sigue igual; cambia a partir del primer mensaje nuevo recortado.
        const changed = firstChanged(prev, next)
        expect(changed).toBeGreaterThan(2 * cut)
        expect(wireBytes(next)).toBeLessThanOrEqual(BODY_LOW)
        break
      }
      expectPrefix(prev, next)
      expect(cutCount(next)).toBe(cut)
      expect(wireBytes(next)).toBeLessThanOrEqual(BUDGET)
      prev = next
      turns++
    }
    expect(turns).toBeGreaterThanOrEqual(5)
  })

  test("determinista: la misma entrada da los mismos bytes (misma sesión o sesión nueva)", async () => {
    const msgs = () => growing(33)
    const a = JSON.stringify(await run(msgs(), "context", "ses_det_a"))
    const b = JSON.stringify(await run(msgs(), "context", "ses_det_a"))
    const c = JSON.stringify(await run(msgs(), "context", "ses_det_b"))
    expect(b).toBe(a)
    expect(c).toBe(a)
  })

  test("las peticiones de título no guardan estado", async () => {
    const out = await run(growing(33), "title", "ses_title_only")
    expect(wireBytes(out)).toBeLessThanOrEqual(BODY_LOW)
    expect(existsSync(join(cache, "opencode-runinfra", "ses_title_only", "index.json"))).toBe(false)
  })
})

describe("comportamiento previo", () => {
  const img = (n: number, size = 1000) => Buffer.alloc(size, n).toString("base64")
  const media = (data: string) => ({
    type: "media",
    media: { source: { type: "base64", data, mediaType: "image/png" } },
    filename: "clipboard",
  })
  const texts = (out: any[]) =>
    out.flatMap((m) =>
      m.content.flatMap((p: any) =>
        p.type === "text" ? [p.text] : p.type === "tool-result" ? p.result.value.filter((v: any) => v.type === "text").map((v: any) => v.text) : [],
      ),
    )
  const inline = (out: any[]) =>
    out.flatMap((m) =>
      m.content.flatMap((p: any) =>
        p.type === "media" ? [p] : p.type === "tool-result" ? p.result.value.filter((v: any) => v.type === "file") : [],
      ),
    ).length

  // Imagen i: impares como adjunto del usuario, pares como resultado de read.
  const imageMsgs = (count: number, from = 1) => {
    const out: any[] = []
    for (let i = from; i <= count; i++) {
      if (i % 2) out.push({ role: "user", content: [media(img(i))] })
      else {
        out.push(call(`r${i}`, "read", { filePath: `/no/existe/${i}.png` }))
        out.push(result(`r${i}`, "read", { type: "content", value: [{ type: "file", mime: "image/png", uri: `data:image/png;base64,${img(i)}` }] }))
      }
    }
    return out
  }
  const labelsOf = (out: any[]) => texts(out).filter((t) => t.startsWith("[imagen")).map((t) => t.match(/^\[imagen \d+( omitida)?/)![0])
  const expected = (dropped: number, total: number) =>
    Array.from({ length: total }, (_, i) => `[imagen ${i + 1}${i < dropped ? " omitida" : ""}`)

  test("imágenes por lotes: hasta 8 en línea; la 9.ª deja 4 y las siguientes solo se añaden", async () => {
    const ses = "ses_images_batch"
    let prev = await run(imageMsgs(8), "context", ses)
    expect(inline(prev)).toBe(8)
    expect(labelsOf(prev)).toEqual(expected(0, 8))

    // 9.ª imagen: se pasa del límite duro → se descartan las más antiguas hasta 4.
    let next = await run(imageMsgs(9), "context", ses)
    expect(inline(next)).toBe(4)
    expect(labelsOf(next)).toEqual(expected(5, 9))
    expect(texts(next).find((t) => t.startsWith("[imagen 1 omitida"))).toContain("vuelve a leer")
    expect(firstChanged(prev, next)).toBe(0) // el lote sí cambia el prefijo (imagen 1, primer mensaje)

    // 10.ª a 13.ª: se añaden sin tocar nada anterior (prefijo idéntico byte a byte).
    prev = next
    for (let n = 10; n <= 13; n++) {
      next = await run(imageMsgs(n), "context", ses)
      expectPrefix(prev, next)
      expect(inline(next)).toBe(n - 5)
      expect(labelsOf(next)).toEqual(expected(5, n))
      prev = next
    }

    // 14.ª: otra vez 9 en línea → nuevo lote hasta 4; las ya omitidas no cambian.
    next = await run(imageMsgs(14), "context", ses)
    expect(inline(next)).toBe(4)
    expect(labelsOf(next)).toEqual(expected(10, 14))
    const firstImage6 = prev.findIndex((m) => JSON.stringify(m).includes("[imagen 6"))
    expect(firstChanged(prev, next)).toBe(firstImage6)
    for (let i = 0; i < firstImage6; i++) expect(JSON.stringify(next[i])).toBe(JSON.stringify(prev[i]))

    // Repetir la misma petición da exactamente los mismos bytes.
    expect(JSON.stringify(await run(imageMsgs(14), "context", ses))).toBe(JSON.stringify(next))
  })

  test("una imagen descartada que se vuelve a leer se ve (otra aparición, mismo número)", async () => {
    const ses = "ses_reread"
    await run(imageMsgs(8), "context", ses)
    const base = imageMsgs(9)
    await run(base, "context", ses)
    const reread = [
      ...imageMsgs(9),
      call("again1", "read", { filePath: "/no/existe/2.png" }),
      result("again1", "read", { type: "content", value: [{ type: "file", mime: "image/png", uri: `data:image/png;base64,${img(2)}` }] }),
    ]
    const out = await run(reread, "context", ses)
    expect(labelsOf(out)).toEqual([...expected(5, 9), "[imagen 2"])
    expect(inline(out)).toBe(5)
  })

  test("nunca más de 8 en línea, contando las nuevas de la propia petición", async () => {
    // Sesión nueva con 10 imágenes: todas nuevas → se quedan las 8 más recientes.
    const a = await run(imageMsgs(10), "context", "ses_cap_a")
    expect(inline(a)).toBe(8)
    expect(labelsOf(a)).toEqual(expected(2, 10))
    // 3 ya vistas + 7 nuevas en la misma petición: se conservan las 7 nuevas (≤ 8), no solo 4.
    await run(imageMsgs(3), "context", "ses_cap_b")
    const b = await run(imageMsgs(10), "context", "ses_cap_b")
    expect(inline(b)).toBe(7)
    expect(labelsOf(b)).toEqual(expected(3, 10))
  })

  test("tope de base64 en línea: descarta las más antiguas hasta ~2,5 MB", async () => {
    const out = await run([1, 2, 3].map((n) => ({ role: "user", content: [media(img(n, 750_000))] })))
    expect(inline(out)).toBe(2)
    expect(texts(out)[0]).toMatch(/^\[imagen 1 omitida/)
  })

  test("tope de base64 por lotes: al pasar de 2,5 MB baja a ≤ 1,5 MB y luego solo añade", async () => {
    const ses = "ses_inline_batch"
    const shots = (n: number) => Array.from({ length: n }, (_, i) => ({ role: "user", content: [media(img(i + 1, 300_000))] })) // 400 KB c/u
    let prev = await run(shots(6), "context", ses) // 2,4 MB: cabe
    expect(inline(prev)).toBe(6)
    let next = await run(shots(7), "context", ses) // 2,8 MB → lote hasta ≤ 1,5 MB (3 imágenes)
    expect(inline(next)).toBe(3)
    expect(labelsOf(next)).toEqual(expected(4, 7))
    prev = next
    for (let n = 8; n <= 9; n++) {
      next = await run(shots(n), "context", ses)
      expectPrefix(prev, next)
      expect(inline(next)).toBe(n - 4)
      prev = next
    }
  })

  test("no muta las partes originales al etiquetar imágenes", async () => {
    const msgs = [{ role: "user", content: [media(img(42))] }]
    const part = msgs[0].content[0]
    const before = JSON.stringify(part)
    const out = await run(msgs)
    expect(JSON.stringify(part)).toBe(before)
    expect(out[0].content.length).toBe(2)
  })

  test("los inputs de tool call que no son objetos se convierten en objetos", async () => {
    const out = await run([
      user("x"),
      call("s", "read", '{"path":"/a"}'),
      call("g", "read", "basura"),
      call("a", "read", [1, 2]),
      call("n", "read", null),
      call("o", "read", { ok: true }),
    ])
    expect(out.slice(1).map((m) => m.content[1].input)).toEqual([{ path: "/a" }, {}, {}, {}, { ok: true }])
  })
})
