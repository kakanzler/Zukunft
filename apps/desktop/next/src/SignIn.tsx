"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { AuthStatus, DeviceCode } from "@zukunft/github/tauri"
import { GitHubError, describeError } from "@zukunft/github"

type Props = { onSignedIn: (status: AuthStatus) => void }

/**
 * サインイン（企画書 §11）。
 *
 * 既定は OAuth Device Flow。Client ID がビルドに埋め込まれていない場合に備え、
 * プロトタイプ用の PAT 入力も残す。どちらもトークンは Rust 側の
 * Secure Storage に入り、この画面には戻ってこない。
 */
export function SignIn({ onSignedIn }: Props) {
  const [device, setDevice] = useState<DeviceCode | null>(null)
  const [token, setToken] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<GitHubError | null>(null)
  const polling = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (polling.current !== null) window.clearTimeout(polling.current)
    }
  }, [])

  const startDeviceFlow = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const { auth } = await import("@zukunft/github/tauri")
      const code = await auth.startDeviceFlow()
      setDevice(code)

      // 承認されるまで interval 秒ごとに問い合わせる。
      const poll = async () => {
        try {
          const status = await auth.pollDeviceFlow(code.deviceCode)
          onSignedIn(status)
        } catch (e) {
          const err = e instanceof GitHubError ? e : new GitHubError("unknown", String(e))
          if (err.kind === "unauthorized") {
            polling.current = window.setTimeout(poll, code.interval * 1000)
          } else {
            setError(err)
            setDevice(null)
          }
        }
      }
      polling.current = window.setTimeout(poll, code.interval * 1000)
    } catch (e) {
      setError(e instanceof GitHubError ? e : new GitHubError("unknown", String(e)))
    } finally {
      setBusy(false)
    }
  }, [onSignedIn])

  const signInWithToken = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const { auth } = await import("@zukunft/github/tauri")
      onSignedIn(await auth.signInWithToken(token))
    } catch (e) {
      setError(e instanceof GitHubError ? e : new GitHubError("unknown", String(e)))
    } finally {
      setBusy(false)
    }
  }, [token, onSignedIn])

  const info = error ? describeError(error) : null

  return (
    <div className="zk-empty">
      <h2>GitHub にサインイン</h2>

      {device ? (
        <div className="zk-card" style={{ display: "grid", gap: 8, minWidth: 360 }}>
          <div style={{ color: "var(--text-secondary)", fontSize: 11 }}>
            ブラウザで次の URL を開き、コードを入力してください。
          </div>
          <div style={{ fontSize: 22, letterSpacing: "0.2em", fontWeight: 600 }}>
            {device.userCode}
          </div>
          <button
            className="zk-button"
            onClick={async () => {
              const { auth } = await import("@zukunft/github/tauri")
              await auth.openExternal(device.verificationUri)
            }}
          >
            ブラウザで開く
          </button>
          <div style={{ color: "var(--text-secondary)", fontSize: 11, userSelect: "text" }}>
            {device.verificationUri}
          </div>
          <div style={{ color: "var(--text-secondary)", fontSize: 11 }}>承認を待っています…</div>
        </div>
      ) : (
        <button className="zk-button" disabled={busy} onClick={startDeviceFlow}>
          ブラウザで承認する（Device Flow）
        </button>
      )}

      <details style={{ marginTop: 8 }}>
        <summary style={{ cursor: "pointer", fontSize: 11 }}>
          Personal Access Token で入る
        </summary>
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <input
            className="zk-button"
            type="password"
            value={token}
            placeholder="github_pat_..."
            onChange={(e) => setToken(e.target.value)}
            style={{ minWidth: 280, cursor: "text" }}
          />
          <button className="zk-button" disabled={busy || token.length === 0}
                  onClick={signInWithToken}>
            サインイン
          </button>
        </div>
        <div style={{ color: "var(--text-secondary)", fontSize: 10, marginTop: 6 }}>
          必要な権限は Issues: Read と Projects: Read &amp; Write です。
        </div>
      </details>

      {info && (
        <div className="zk-card" style={{ borderColor: "var(--danger)" }}>
          <div style={{ fontWeight: 600 }}>{info.title}</div>
          <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>{error?.message}</div>
        </div>
      )}
    </div>
  )
}
