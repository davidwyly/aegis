"use client"

export function BriefDownloadButton({
  fileName,
  body,
}: {
  fileName: string
  body: string
}) {
  function download() {
    const blob = new Blob([body], { type: "text/plain;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = fileName
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }
  return (
    <button onClick={download} className="btn-secondary text-xs">
      Download brief
    </button>
  )
}
