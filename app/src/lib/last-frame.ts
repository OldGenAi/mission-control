/**
 * The last frame of a finished video, as a PNG data: URL, for "Continue from this clip". It is read in the
 * browser from the video Mission Control already serves (same origin, so the canvas may be read back), and
 * then uploaded like any chosen picture, so the gateway checks it the same way.
 */
export function lastFrame(src: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    let timer = 0
    const finish = (outcome: string | Error) => {
      window.clearTimeout(timer)
      video.onerror = video.onloadedmetadata = video.onseeked = null
      video.removeAttribute('src')
      video.load()
      if (typeof outcome === 'string') resolve(outcome)
      else reject(outcome)
    }
    timer = window.setTimeout(() => finish(new Error('The video took too long to load.')), 20_000)
    video.muted = true
    video.preload = 'auto'
    video.onerror = () => finish(new Error('Could not open that video.'))
    // A hundredth of a second before the end lands on the last frame (24 a second); at the very end some
    // browsers show no frame at all.
    video.onloadedmetadata = () => { video.currentTime = Math.max(0, video.duration - 0.01) }
    video.onseeked = () => {
      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      const context = canvas.getContext('2d')
      if (!context || canvas.width === 0) return finish(new Error('Could not read the last frame.'))
      context.drawImage(video, 0, 0)
      finish(canvas.toDataURL('image/png'))
    }
    video.src = src
  })
}
