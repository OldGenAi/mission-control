import React from 'react'
import { useAssistantName } from '../lib/assistant'

interface Channel {
  id: string
  name: string
  description: string
  color: string
}

const CHANNELS: Channel[] = [
  { id: 'telegram',  name: 'Telegram',  description: 'Bot API: receive and send messages via Telegram',          color: '#229ED9' },
  { id: 'discord',   name: 'Discord',   description: 'Bot: {name} in your Discord server or DM',                   color: '#5865F2' },
  { id: 'slack',     name: 'Slack',     description: 'App: {name} in your Slack workspace',                         color: '#4A154B' },
  { id: 'whatsapp',  name: 'WhatsApp',  description: 'Cloud API: {name} via WhatsApp Business',                     color: '#25D366' },
  { id: 'signal',    name: 'Signal',    description: 'Signal CLI: end-to-end encrypted messaging',               color: '#3A76F0' },
  { id: 'imessage',  name: 'iMessage',  description: 'AppleScript bridge: {name} via iMessage on macOS',           color: '#1C8EF9' },
]

const ChannelIcon: React.FC<{ color: string; name: string }> = ({ color, name }) => (
  <div
    className="w-12 h-12 rounded-2xl flex items-center justify-center text-white font-bold text-lg"
    style={{ backgroundColor: `${color}20`, border: `1px solid ${color}40` }}
  >
    <span style={{ color }}>{name[0]}</span>
  </div>
)

export const ChannelsPage: React.FC = () => {
  const assistant = useAssistantName()
  return (
  <div className="p-6 h-full overflow-y-auto">
    <div className="mb-6">
      <p className="text-xs text-gray-500">
        Connect {assistant} to external messaging platforms. Channels are coming in a future phase. The groundwork is ready, connecting them is next.
      </p>
    </div>
    <div className="grid grid-cols-3 gap-4">
      {CHANNELS.map((ch) => (
        <div key={ch.id} className="rounded-xl p-5 transition-all" style={{ background: 'rgba(6,10,16,0.88)', border: '1px solid rgba(255,255,255,0.07)' }}
          onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'rgba(0,200,255,0.2)')}
          onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.07)')}
        >
          <div className="flex items-start gap-4 mb-4">
            <ChannelIcon color={ch.color} name={ch.name} />
            <div className="min-w-0 flex-1">
              <h3 className="font-medium text-sm">{ch.name}</h3>
              <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{ch.description.replace('{name}', assistant)}</p>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-gray-600" />
              <span className="text-xs text-gray-500">Not connected</span>
            </div>
            <button
              disabled
              className="px-3 py-1.5 text-xs rounded-lg cursor-not-allowed"
              style={{ background: 'rgba(0,200,255,0.04)', border: '1px solid rgba(0,200,255,0.15)', color: '#4B5563' }}
              title="Coming in a future phase"
            >
              Connect →
            </button>
          </div>
          <p className="text-xs text-gray-700 mt-2">Coming in a future phase</p>
        </div>
      ))}
    </div>
  </div>
  )
}

export default ChannelsPage
