"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, type Room } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Card, CardBody } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { ToastProvider, useToast } from "@/components/ui/Toast";

function HomePageContent() {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [tab, setTab] = useState<"search" | "hot" | "artist" | "history">("search");
  const [hot, setHot] = useState<Array<{ video_id: string; title: string; play_count: number }>>([]);
  const [artists, setArtists] = useState<Array<{ artist: string; play_count: number }>>([]);
  const [history, setHistory] = useState<Array<{ title: string; created_at: number }>>([]);
  const [name, setName] = useState("");
  const [rate, setRate] = useState(8);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      setRooms(await api.listRooms());
    } catch (e: any) {
      toast({ variant: "error", message: e.message || "載入包廂失敗" });
    }
  }, [toast]);

  useEffect(() => {
    load();
    api.getLocalCharts("week").then(setHot).catch(() => {});
    api.getPopularArtists(30).then(setArtists).catch(() => {});
    if (typeof window !== "undefined") {
      const raw = window.localStorage?.getItem?.("ktv-local-history");
      if (raw) {
        try {
          setHistory(JSON.parse(raw));
        } catch {}
      }
    }
  }, [load]);

  async function create() {
    if (!name.trim()) {
      toast({ variant: "warning", message: "請輸入包廂名稱" });
      return;
    }
    setCreating(true);
    try {
      await api.createRoom(name, rate);
      setName("");
      setRate(8);
      toast({ variant: "success", message: "建立包廂成功！" });
      await load();
    } catch (e: any) {
      toast({ variant: "error", message: e.message || "建立包廂失敗" });
    } finally {
      setCreating(false);
    }
  }

  return (
    <main className="min-h-screen bg-ktv-bg flex flex-col text-white pb-safe-bottom">
      {/* Hero Section */}
      <section className="relative w-full pt-16 pb-12 px-6 flex flex-col items-center justify-center overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-b from-ktv-accent/10 to-transparent pointer-events-none" />
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[400px] bg-pink-gold opacity-20 blur-[120px] rounded-full pointer-events-none" />
        <div className="z-10 text-center animate-fade-up">
          <Badge variant="gold" className="mb-6 mx-auto px-3 py-1">
            v1.0 Demo
          </Badge>
          <h1 className="text-6xl md:text-7xl font-extrabold tracking-tight mb-4 drop-shadow-lg text-transparent bg-clip-text bg-gradient-to-br from-white via-white to-ktv-gold">
            🎤 KTV Box
          </h1>
          <p className="text-xl md:text-2xl text-white/70 font-medium mb-2">
            在家就是 KTV 包廂
          </p>
          <p className="text-sm text-white/50 max-w-md mx-auto">
            筆電接電視，手機當遙控器。<br />
            點歌、切伴奏、發特效，無需昂貴設備即可歡唱。
          </p>
        </div>
      </section>

      {/* Main Content */}
      <section className="flex-1 w-full max-w-4xl mx-auto px-6 flex flex-col gap-10 pb-16 z-10">
        
        {/* Create Room */}
        <Card glow className="bg-panel border-white/5 shadow-2xl relative overflow-hidden group">
          <div className="absolute top-0 right-0 p-32 bg-ktv-accent/5 rounded-full blur-3xl -z-10 group-hover:bg-ktv-accent/10 transition-colors duration-500" />
          <CardBody className="p-6 md:p-8 flex flex-col md:flex-row gap-4 items-end">
            <div className="w-full flex-1">
              <label htmlFor="room-name" className="block text-sm font-bold text-white/80 mb-2">建立新包廂</label>
              <Input
                id="room-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如: 週末狂歡夜"
                className="w-full bg-white/5 border-white/10 focus:border-ktv-accent"
              />
            </div>
            <div className="w-full md:w-32">
              <label htmlFor="room-rate" className="block text-sm font-bold text-white/80 mb-2">費率</label>
              <Input
                id="room-rate"
                type="number"
                value={rate}
                onChange={(e) => setRate(Number(e.target.value))}
                placeholder="8"
                rightAddon="$/分"
                className="w-full bg-white/5 border-white/10 focus:border-ktv-accent"
              />
            </div>
            <Button
              size="lg"
              variant="primary"
              className="w-full md:w-auto mt-4 md:mt-0 whitespace-nowrap"
              onClick={create}
              loading={creating}
            >
              建立包廂
            </Button>
          </CardBody>
        </Card>

        <Card className="bg-panel border-white/10">
          <CardBody className="p-4">
            <div className="flex gap-2 mb-3 text-sm">
              <Button variant={tab === "search" ? "primary" : "ghost"} onClick={() => setTab("search")}>搜尋</Button>
              <Button variant={tab === "hot" ? "primary" : "ghost"} onClick={() => setTab("hot")}>熱門</Button>
              <Button variant={tab === "artist" ? "primary" : "ghost"} onClick={() => setTab("artist")}>歌手</Button>
              <Button variant={tab === "history" ? "primary" : "ghost"} onClick={() => setTab("history")}>點唱史</Button>
            </div>
            {tab === "hot" && (
              <ul className="space-y-1 text-sm">
                {hot.slice(0, 10).map((h, i) => <li key={`${h.video_id}-${h.title}`}>{i + 1}. {h.title} · {h.play_count}</li>)}
              </ul>
            )}
            {tab === "artist" && (
              <ul className="space-y-1 text-sm">
                {artists.slice(0, 10).map((a) => <li key={a.artist}>{a.artist} · {a.play_count}</li>)}
              </ul>
            )}
            {tab === "history" && (
              <ul className="space-y-1 text-sm">
                {history.slice(0, 10).map((h, i) => <li key={`${h.title}-${h.created_at || i}`}>{h.title}</li>)}
              </ul>
            )}
            {tab === "search" && <div className="text-sm text-white/60">使用上方包廂搜尋/建立流程</div>}
          </CardBody>
        </Card>

        {/* Existing Rooms */}
        <div className="flex flex-col gap-4">
          <h2 className="text-2xl font-bold flex items-center gap-3">
            現有包廂
            <Badge variant="outline" className="text-white/60 border-white/20">{rooms.length}</Badge>
          </h2>

          {rooms.length === 0 ? (
            <div className="py-16 text-center border-2 border-dashed border-white/10 rounded-3xl bg-white/5">
              <div className="text-6xl mb-4 opacity-80">🛋️</div>
              <h3 className="text-xl font-bold mb-2">目前沒有包廂</h3>
              <p className="text-white/50 mb-6">點擊上方按鈕建立第一間包廂</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {rooms.map((r) => (
                <Card key={r.id} className="bg-panel border-white/5 hover:border-white/15 transition-all group overflow-hidden relative">
                  <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-ktv-gold to-ktv-accent opacity-50 group-hover:opacity-100 transition-opacity" />
                  <CardBody className="p-5 flex flex-col gap-4">
                    <div className="flex justify-between items-start">
                      <div>
                        <h3 className="text-xl font-bold text-ktv-gold mb-1 truncate pr-2" title={r.name}>{r.name}</h3>
                        <div className="flex items-center gap-2">
                          <Badge variant="default" className="bg-white/10 text-white/70 text-xs px-2 py-0.5">ID: {r.id}</Badge>
                          <Badge variant="outline" className="border-ktv-mic/30 text-ktv-mic text-xs px-2 py-0.5">{r.rate_per_minute} 元/分</Badge>
                        </div>
                      </div>
                    </div>
                    
                    <div className="flex flex-col gap-2 mt-2">
                      <Button asChild variant="gold" size="md" className="w-full shadow-md">
                        <Link href={`/tv/${r.id}`}>TV 大螢幕</Link>
                      </Button>
                      <Button asChild variant="primary" size="md" className="w-full">
                        <Link href={`/m/${r.id}`}>📱 手機點歌</Link>
                      </Button>
                    </div>
                  </CardBody>
                </Card>
              ))}
            </div>
          )}
        </div>

      </section>

      {/* Footer */}
      <footer className="mt-auto py-8 text-center text-white/30 text-sm border-t border-white/5">
        <p className="font-medium mb-1">KTV Box v1.0.0</p>
        <p>僅供個人 / 教育用途。請勿用於商業營利。</p>
      </footer>
    </main>
  );
}

export default function HomePage() {
  return (
    <ToastProvider>
      <HomePageContent />
    </ToastProvider>
  );
}
