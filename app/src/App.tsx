import { useEffect } from "react"
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom"
import { Sidebar } from "./components/Sidebar"
import { ChatPage } from "./pages/ChatPage"
import { SettingsPage } from "./pages/SettingsPage"
import { AgentsPage } from "./pages/AgentsPage"
import { OverviewPage } from "./pages/OverviewPage"
import { SessionsPage } from "./pages/SessionsPage"
import { PipelinesPage } from "./pages/PipelinesPage"
import { MemoryPage } from "./pages/MemoryPage"
import { ChannelsPage } from "./pages/ChannelsPage"
import { MonitorPage } from "./pages/MonitorPage"
import { ArtifactsPage } from "./pages/ArtifactsPage"

// ---------- breadcrumb -------------------------------------------

const PAGE_META: Record<string, { label: string }> = {
  "/":                    { label: "Overview"  },
  "/overview":            { label: "Overview"  },
  "/chat":                { label: "Chat"      },
  "/pipelines/runs":      { label: "Runs"      },
  "/pipelines/approvals": { label: "Approvals" },
  "/artifacts":           { label: "Artifacts" },
  "/agents":              { label: "Agents"    },
  "/sessions":            { label: "Sessions"  },
  "/memory":              { label: "Memory"    },
  "/monitor/live":        { label: "Live"      },
  "/monitor/history":     { label: "History"   },
  "/monitor/errors":      { label: "Errors"    },
  "/channels":            { label: "Channels"  },
  "/settings":            { label: "Settings"  },
}

function TopBar() {
  const location = useLocation()
  const meta = PAGE_META[location.pathname]
  const pageLabel = meta?.label ?? ""

  return (
    <header className="topbar">
      <nav className="breadcrumb">
        <a href="/overview">Mission Control</a>
        <span className="breadcrumb__sep">›</span>
        <span>OG AI</span>
        {pageLabel && (
          <>
            <span className="breadcrumb__sep">›</span>
            <span className="breadcrumb__current">{pageLabel}</span>
          </>
        )}
      </nav>
    </header>
  )
}

// ---------- shell ------------------------------------------------

function Shell() {
  return (
    <div className="shell">
      <Sidebar />
      <div className="main-content">
        <TopBar />
        <div className="page-content">
          <Routes>
            <Route path="/"        element={<Navigate to="/overview" replace />} />
            <Route path="/overview" element={<OverviewPage />} />
            <Route path="/chat"    element={<ChatPage />} />

            <Route path="/pipelines/runs"      element={<PipelinesPage />} />
            <Route path="/pipelines/approvals" element={<PipelinesPage />} />

            <Route path="/artifacts" element={<ArtifactsPage />} />

            <Route path="/agents"   element={<AgentsPage />} />
            <Route path="/sessions" element={<SessionsPage />} />
            <Route path="/memory"   element={<MemoryPage />} />
            <Route path="/channels" element={<ChannelsPage />} />

            <Route path="/monitor/live"    element={<MonitorPage />} />
            <Route path="/monitor/history" element={<MonitorPage />} />
            <Route path="/monitor/errors"  element={<MonitorPage />} />

            <Route path="/settings" element={<SettingsPage />} />

            <Route path="*" element={<Navigate to="/overview" replace />} />
          </Routes>
        </div>
      </div>
    </div>
  )
}

export default function App() {
  useEffect(() => {
    const theme = localStorage.getItem("mc:uiTheme") ?? "aurora"
    if (theme !== "aurora") document.documentElement.setAttribute("data-theme", theme)
    const accent = localStorage.getItem("mc:accentColor")
    if (accent) document.documentElement.style.setProperty("--accent", accent)
  }, [])

  return (
    <BrowserRouter>
      <Shell />
    </BrowserRouter>
  )
}
