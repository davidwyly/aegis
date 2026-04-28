"use client"
import { useEffect, useState } from "react"

export function BriefEditor({ caseId }: { caseId: string }) {
  const [body, setBody] = useState("")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`/api/cases/${caseId}/briefs/me`)
        if (res.status === 401) {
          setError("Sign in with the wallet of a party to write a brief.")
          return
        }
        const data = await res.json()
        if (data.brief) setBody(data.brief.body ?? "")
      } catch (err) {
        setError(err instanceof Error ? err.message : "load failed")
      } finally {
        setLoading(false)
      }
    })()
  }, [caseId])

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/cases/${caseId}/briefs/me`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error ?? `HTTP ${res.status}`)
      }
      setSaved(new Date().toLocaleTimeString())
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed")
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div className="text-sm text-zinc-500">Loading brief…</div>
  if (error) return <div className="text-sm text-rose-700 dark:text-rose-300">{error}</div>

  return (
    <div className="space-y-2">
      <textarea
        className="input min-h-[160px] w-full font-mono text-sm"
        value={body}
        maxLength={8000}
        onChange={(e) => setBody(e.target.value)}
        placeholder="State your case. Plain text or Markdown."
      />
      <div className="flex items-center gap-3 text-xs">
        <button onClick={save} disabled={saving || body.trim().length === 0} className="btn-primary">
          {saving ? "Saving…" : "Save brief"}
        </button>
        <span className="text-zinc-500">{body.length} / 8000</span>
        {saved && <span className="text-emerald-700 dark:text-emerald-400">Saved {saved}</span>}
      </div>
    </div>
  )
}
