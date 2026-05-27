import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B'
  }
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`
}

export function compactPath(path: string, max = 64) {
  if (path.length <= max) {
    return path
  }
  const parts = path.split('/')
  if (parts.length <= 2) {
    return `...${path.slice(-(max - 3))}`
  }
  const head = parts[0]
  let tail = parts.slice(-2).join('/')
  let out = `${head}/.../${tail}`
  if (out.length <= max) {
    return out
  }
  if (tail.length > max - head.length - 8) {
    tail = `...${tail.slice(-(max - head.length - 11))}`
  }
  return `${head}/.../${tail}`
}

export function formatDateTime(value: string) {
  if (!value) {
    return '-'
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return date.toLocaleString('zh-CN', {
    hour12: false,
  })
}

export function cnJoin(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(' ')
}
