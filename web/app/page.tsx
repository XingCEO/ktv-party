"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, type Room } from "@/lib/api";

export default function HomePage() {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [name, setName] = useState("包廂A");
  const [rate, setRate] = useState(8);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    try {
      setRooms(await api.listRooms());
    } catch (e: any) {
      setErr(e.message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function create() {
    setErr(null);
    try {
      await api.createRoom(name, rate);
      setName("");
      load();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  return (
    <main className="min-h-screen p-8 max-w-3xl mx-auto">
      <h1 className="text-4xl font-extrabold mb-2 text-ktv-gold">KTV Box</h1>
      <p className="text-white/60 mb-8">個人學習 / Demo - 區網點唱系統</p>

      <section className="panel p-6 mb-8">
        <h2 className="text-xl font-bold mb-4">建立新包廂</h2>
        <div className="flex gap-2 flex-wrap">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="包廂名稱"
            className="flex-1 min-w-[180px] px-3 py-2 rounded-lg bg-white/5 border border-white/10"
          />
          <input
            type="number"
            value={rate}
            onChange={(e) => setRate(Number(e.target.value))}
            className="w-32 px-3 py-2 rounded-lg bg-white/5 border border-white/10"
            placeholder="元/分鐘"
          />
          <button onClick={create} className="btn-primary">
            建立
          </button>
        </div>
        {err && <p className="text-ktv-accent mt-2 text-sm">{err}</p>}
      </section>

      <section className="panel p-6">
        <h2 className="text-xl font-bold mb-4">現有包廂</h2>
        {rooms.length === 0 ? (
          <p className="text-white/50">目前沒有包廂,請先建立。</p>
        ) : (
          <ul className="space-y-3">
            {rooms.map((r) => (
              <li
                key={r.id}
                className="flex items-center justify-between bg-white/5 rounded-xl px-4 py-3"
              >
                <div>
                  <div className="font-bold text-lg">{r.name}</div>
                  <div className="text-xs text-white/50">
                    ID: {r.id} · {r.rate_per_minute} 元/分
                  </div>
                </div>
                <div className="flex gap-2">
                  <Link href={`/tv/${r.id}`} className="btn-ghost">
                    TV 大螢幕
                  </Link>
                  <Link href={`/m/${r.id}`} className="btn-primary">
                    手機點歌
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
