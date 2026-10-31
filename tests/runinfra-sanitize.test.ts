// Pruebas rápidas de plugins/runinfra-sanitize.ts con mensajes falsos (sin red ni opencode).
// Ejecutar:  bun test
// Otra copia del plugin:  RUNINFRA_SANITIZE_PLUGIN=/ruta/al/plugin.ts bun test
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const PLUGIN = process.env.RUNINFRA_SANITIZE_PLUGIN ?? join(import.meta.dir, "../plugins/runinfra-sanitize.ts")
const BUDGET = 3_000_000
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

  test("conserva las 6 imágenes más recientes con etiquetas numeradas estables", async () => {
    const msgs = (count: number) => {
      const out: any[] = []
      for (let i = 1; i <= count; i++) {
        if (i % 2) out.push({ role: "user", content: [media(img(i))] })
        else {
          out.push(call(`r${i}`, "read", { filePath: `/no/existe/${i}.png` }))
          out.push(result(`r${i}`, "read", { type: "content", value: [{ type: "file", mime: "image/png", uri: `data:image/png;base64,${img(i)}` }] }))
        }
      }
      return out
    }
    const first = await run(msgs(8), "context", "ses_labels")
    expect(inline(first)).toBe(6)
    const labels = texts(first).filter((t) => t.startsWith("[imagen"))
    expect(labels.map((t) => t.match(/^\[imagen \d+( omitida)?/)![0])).toEqual([
      "[imagen 1 omitida",
      "[imagen 2 omitida",
      "[imagen 3",
      "[imagen 4",
      "[imagen 5",
      "[imagen 6",
      "[imagen 7",
      "[imagen 8",
    ])
    expect(labels[0]).toContain("vuelve a leer")
    // Segunda petición con una imagen más: los números no cambian.
    const second = await run(msgs(9), "context", "ses_labels")
    expect(inline(second)).toBe(6)
    expect(texts(second).filter((t) => t.startsWith("[imagen")).map((t) => t.match(/^\[imagen \d+/)![0])).toEqual(
      Array.from({ length: 9 }, (_, i) => `[imagen ${i + 1}`),
    )
  })

  test("tope de base64 en línea: descarta las más antiguas hasta ~2,5 MB", async () => {
    const out = await run([1, 2, 3].map((n) => ({ role: "user", content: [media(img(n, 750_000))] })))
    expect(inline(out)).toBe(2)
    expect(texts(out)[0]).toMatch(/^\[imagen 1 omitida/)
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
