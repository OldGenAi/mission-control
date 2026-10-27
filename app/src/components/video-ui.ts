// Looks and picture helpers shared by the Video page and its cast list.
import type React from 'react'
import { gateway } from '../lib/gateway-client'

export const card: React.CSSProperties = { background: 'rgba(6,10,16,0.88)', border: '1px solid rgba(255,255,255,0.07)' }
export const input: React.CSSProperties = { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', color: '#E5E7EB' }
export const button = (primary = false): React.CSSProperties => ({
  background: primary ? 'rgba(0,200,255,0.12)' : 'rgba(255,255,255,0.05)',
  border: `1px solid ${primary ? 'rgba(0,200,255,0.35)' : 'rgba(255,255,255,0.1)'}`,
  color: primary ? '#67e8f9' : '#9CA3AF',
})
export const linkButton = (color: string): React.CSSProperties => ({ background: 'none', border: 'none', color, cursor: 'pointer' })

// The gateway takes pictures up to 11 MB (PNG, JPEG or WebP) and checks them itself.
export const MAX_PICTURE_BYTES = 11 * 1024 * 1024

export function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('Could not read that file.'))
    reader.readAsDataURL(file)
  })
}

/** A small JPEG copy of the picture, small enough for the browser's storage and the cast list. */
export function thumbnail(dataUrl: string): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const scale = Math.min(1, 256 / Math.max(img.width, img.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(img.width * scale))
      canvas.height = Math.max(1, Math.round(img.height * scale))
      canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height)
      resolve(canvas.toDataURL('image/jpeg', 0.8))
    }
    img.onerror = () => resolve('')
    img.src = dataUrl
  })
}

export interface UploadedPicture { id: string; width: number; height: number; dataUrl: string; thumb: string }

/** Sends a picture (as a data: URL) to the gateway, which checks and keeps it, and makes its thumbnail. */
export async function uploadPicture(dataUrl: string): Promise<UploadedPicture> {
  const data = dataUrl.slice(dataUrl.indexOf(',') + 1)
  const uploaded = await gateway.request<{ id: string; width: number; height: number }>('video.uploadImage', { data })
  return { ...uploaded, dataUrl, thumb: await thumbnail(dataUrl) }
}

/** Reads a chosen file and uploads it, or says plainly why it couldn't. */
export async function uploadPictureFile(file: File): Promise<UploadedPicture> {
  if (file.size > MAX_PICTURE_BYTES) throw new Error(`That picture is ${(file.size / 1024 ** 2).toFixed(1)} MB. The limit is 11 MB.`)
  return uploadPicture(await readAsDataUrl(file))
}
