import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { fetchModelLimits } from '../src/model-info.js'

const catalog = {
  openai: {
    id: 'openai',
    models: {
      'gpt-6-astra': {
        id: 'gpt-6-astra',
        limit: { context: 1_050_000, input: 922_000, output: 128_000 },
      },
      'text-embedding-3-small': { id: 'text-embedding-3-small', limit: { context: 0, output: 0 } },
    },
  },
  xai: {
    id: 'xai',
    models: {
      'grok-4.7': { id: 'grok-4.7', limit: { context: 256_000, output: 64_000 } },
    },
  },
  groq: {
    id: 'groq',
    models: {
      'meta-llama/llama-4-scout-17b-16e-instruct': {
        id: 'meta-llama/llama-4-scout-17b-16e-instruct',
        limit: { context: 131_072, output: 8_192 },
      },
    },
  },
}

function catalogFetch(models: unknown, options: { ok?: boolean } = {}) {
  let calls = 0
  const fetch = (async () => {
    calls++
    const body = options.ok === false ? 'nope' : JSON.stringify(models)
    return new Response(body, { status: options.ok === false ? 503 : 200 })
  }) as typeof globalThis.fetch

  return { fetch, calls: () => calls }
}

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'miniagent-models-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('fetchModelLimits', () => {
  it('reads a bare model id from the default provider', async () => {
    const limits = await fetchModelLimits('gpt-6-astra', {
      catalogUrl: 'https://example.test/one',
      fetch: catalogFetch(catalog).fetch,
    })

    expect(limits).toEqual({
      id: 'openai/gpt-6-astra',
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
    })
  })

  it('reads a named provider', async () => {
    const limits = await fetchModelLimits('grok-4.7', {
      catalogUrl: 'https://example.test/two',
      provider: 'xai',
      fetch: catalogFetch(catalog).fetch,
    })

    expect(limits).toEqual({ id: 'xai/grok-4.7', contextWindow: 256_000, maxOutputTokens: 64_000 })
  })

  it('reads a provider-qualified id', async () => {
    const limits = await fetchModelLimits('xai/grok-4.7', {
      catalogUrl: 'https://example.test/three',
      fetch: catalogFetch(catalog).fetch,
    })

    expect(limits?.id).toBe('xai/grok-4.7')
  })

  it('keeps model ids that contain a slash', async () => {
    const limits = await fetchModelLimits('meta-llama/llama-4-scout-17b-16e-instruct', {
      catalogUrl: 'https://example.test/four',
      provider: 'groq',
      fetch: catalogFetch(catalog).fetch,
    })

    expect(limits?.id).toBe('groq/meta-llama/llama-4-scout-17b-16e-instruct')
    expect(limits?.contextWindow).toBe(131_072)
  })

  it('returns undefined for unknown models', async () => {
    const limits = await fetchModelLimits('not-a-model', {
      catalogUrl: 'https://example.test/five',
      fetch: catalogFetch(catalog).fetch,
    })

    expect(limits).toBeUndefined()
  })

  it('ignores non-positive limits', async () => {
    const limits = await fetchModelLimits('text-embedding-3-small', {
      catalogUrl: 'https://example.test/six',
      fetch: catalogFetch(catalog).fetch,
    })

    expect(limits).toEqual({
      id: 'openai/text-embedding-3-small',
      contextWindow: undefined,
      maxOutputTokens: undefined,
    })
  })

  it('caches the catalog in memory per url', async () => {
    const fake = catalogFetch(catalog)
    const url = 'https://example.test/seven'

    await fetchModelLimits('gpt-6-astra', { catalogUrl: url, fetch: fake.fetch })
    await fetchModelLimits('grok-4.7', { catalogUrl: url, provider: 'xai', fetch: fake.fetch })

    expect(fake.calls()).toBe(1)
  })

  it('writes a disk cache', async () => {
    const cacheFile = join(directory, 'models.json')
    const url = 'https://example.test/eight'

    await fetchModelLimits('gpt-6-astra', {
      catalogUrl: url,
      cacheFile,
      fetch: catalogFetch(catalog).fetch,
    })

    const written = JSON.parse(await readFile(cacheFile, 'utf8')) as {
      url: string
      catalog: typeof catalog
    }
    expect(written.url).toBe(url)
    expect(written.catalog.openai?.models?.['gpt-6-astra']?.limit?.context).toBe(1_050_000)
  })

  it('reuses a disk cache without fetching', async () => {
    const cacheFile = join(directory, 'models.json')
    const url = 'https://example.test/nine'
    await writeFile(cacheFile, JSON.stringify({ url, at: Date.now(), catalog }), 'utf8')

    const offline = catalogFetch(catalog, { ok: false })
    const limits = await fetchModelLimits('grok-4.7', {
      catalogUrl: url,
      provider: 'xai',
      cacheFile,
      fetch: offline.fetch,
    })

    expect(limits?.id).toBe('xai/grok-4.7')
    expect(offline.calls()).toBe(0)
  })

  it('throws when the catalog cannot be read', async () => {
    const failing = catalogFetch(catalog, { ok: false })

    await expect(
      fetchModelLimits('gpt-6-astra', {
        catalogUrl: 'https://example.test/ten',
        fetch: failing.fetch,
      }),
    ).rejects.toThrow(/503/)
  })
})
