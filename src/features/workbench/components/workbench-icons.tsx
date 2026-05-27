import {
  BadgeInfo,
  Boxes,
  File,
  FileArchive,
  FileAudio2,
  FileCode2,
  FileImage,
  FileText,
  FolderOpen,
  ImageIcon,
  ListFilter,
  Replace,
} from 'lucide-react'

const iconMap = {
  BadgeInfo,
  Boxes,
  File,
  FileArchive,
  FileAudio2,
  FileCode2,
  FileImage,
  FileText,
  FolderOpen,
  ImageIcon,
  ListFilter,
  Replace,
} as const

export function WorkbenchIcon({
  name,
  className,
}: {
  name: keyof typeof iconMap
  className?: string
}) {
  const Icon = iconMap[name] ?? File
  return <Icon className={className} />
}
