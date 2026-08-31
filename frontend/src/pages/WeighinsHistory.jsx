import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, API, formatApiError } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Upload, Download, Scale, Search, ArrowRight } from "lucide-react";
import { toast } from "sonner";

const DAY_MS = 24 * 60 * 60 * 1000;

export default function WeighinsHistory() {
  const nav = useNavigate();
  const { isEditor } = useAuth();
  const [athletes, setAthletes] = useState([]);
  const [weighins, setWeighins] = useState([]);
  const [days, setDays] = useState("30");
  const [q, setQ] = useState("");
  const [deltaFilter, setDeltaFilter] = useState("todos"); // todos | ganhou | perdeu | estavel
  const [uploading, setUploading] = useState(false);
  const [uploadingTemplate, setUploadingTemplate] = useState(false);
  const fileRef = useRef(null);
  const templateFileRef = useRef(null);

  const load = async () => {
    const { data } = await api.get(`/weighins?days=${days}`);
    setAthletes(data.athletes || []);
    setWeighins(data.weighins || []);
  };
  useEffect(() => { load(); }, [days]);  // eslint-disable-line

  // Matriz: linhas = atletas (por nome), colunas = datas únicas (desc), valores = peso
  const { dates, byAthlete } = useMemo(() => {
    const dateSet = new Set(weighins.map((w) => w.date));
    const dates = Array.from(dateSet).sort((a, b) => b.localeCompare(a));
    const byAthlete = {};
    for (const w of weighins) {
      if (!byAthlete[w.athlete_id]) byAthlete[w.athlete_id] = {};
      byAthlete[w.athlete_id][w.date] = w.peso_kg;
    }
    return { dates, byAthlete };
  }, [weighins]);

  const rows = useMemo(() => {
    // enriquecer cada atleta com o delta do período (primeira pesagem → última pesagem do período)
    const enriched = athletes.map((a) => {
      const values = byAthlete[a.id] || {};
      const nonEmpty = dates.map((d) => values[d]).filter((v) => v != null);
      const first = nonEmpty[nonEmpty.length - 1]; // dates estão em desc → última posição é a mais antiga
      const last = nonEmpty[0];
      const delta = last != null && first != null ? +(last - first).toFixed(1) : null;
      return { ...a, delta, values, hasData: nonEmpty.length > 0 };
    });

    let r = enriched;
    if (q.trim()) {
      const s = q.toLowerCase();
      r = r.filter((a) => a.nome.toLowerCase().includes(s) || (a.posicao || "").toLowerCase().includes(s));
    }
    if (deltaFilter !== "todos") {
      r = r.filter((a) => {
        if (a.delta == null) return false;
        if (deltaFilter === "ganhou") return a.delta > 0.1;
        if (deltaFilter === "perdeu") return a.delta < -0.1;
        if (deltaFilter === "estavel") return Math.abs(a.delta) <= 0.1;
        return true;
      });
    }
    return [...r].sort((a, b) => a.nome.localeCompare(b.nome, "pt"));
  }, [athletes, byAthlete, dates, q, deltaFilter]);

  const deltaCounts = useMemo(() => {
    const c = { ganhou: 0, perdeu: 0, estavel: 0 };
    for (const a of athletes) {
      const values = byAthlete[a.id] || {};
      const nonEmpty = dates.map((d) => values[d]).filter((v) => v != null);
      if (nonEmpty.length < 2) continue;
      const delta = +(nonEmpty[0] - nonEmpty[nonEmpty.length - 1]).toFixed(1);
      if (delta > 0.1) c.ganhou++;
      else if (delta < -0.1) c.perdeu++;
      else c.estavel++;
    }
    return c;
  }, [athletes, byAthlete, dates]);

  const totalWeighins = weighins.length;

  const onUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`${API}/weighins/import`, {
        method: "POST",
        headers: { Authorization: `Bearer ${localStorage.getItem("trofense_token")}` },
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Erro na importação");
      toast.success(`${data.created} pesagens importadas` + (data.skipped?.length ? ` · ${data.skipped.length} avisos` : ""));
      if (data.skipped?.length) console.warn("Skipped:", data.skipped);
      await load();
    } catch (err) {
      toast.error(formatApiError(err.message) || "Erro na importação");
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  };

  const onDownloadTemplate = async () => {
    try {
      const res = await fetch(`${API}/templates/pesagens`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("trofense_token")}` },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || "Não foi possível descarregar o modelo");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "Trofense_Modelo_Pesagens.xlsx";
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(formatApiError(err.message) || "Erro ao descarregar o modelo");
    }
  };

  const onUploadTemplate = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingTemplate(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`${API}/templates/pesagens`, {
        method: "POST",
        headers: { Authorization: `Bearer ${localStorage.getItem("trofense_token")}` },
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Erro ao enviar o modelo");
      toast.success("Modelo atualizado");
    } catch (err) {
      toast.error(formatApiError(err.message) || "Erro ao enviar o modelo");
    } finally {
      setUploadingTemplate(false);
      e.target.value = "";
    }
  };

  const fmtDate = (d) => {
    const [y, m, day] = d.split("-");
    return `${day}/${m}`;
  };

  return (
    <div className="p-8 max-w-[1400px] mx-auto" data-testid="weighins-history-page">
      <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
        <div>
          <div className="text-xs uppercase tracking-widest text-muted-foreground font-semibold">Departamento Médico</div>
          <h1 className="font-display text-4xl md:text-5xl font-bold tracking-tighter mt-1">Histórico de Pesagens</h1>
          <p className="text-sm text-muted-foreground mt-2 max-w-2xl">
            Registo diário do peso de cada atleta. Importa aqui a folha Excel modelo para atualizar rapidamente todos os registos.
          </p>
        </div>
        {isEditor && (
          <div className="flex gap-2 flex-wrap">
            <Button
              variant="outline"
              className="gap-2"
              onClick={onDownloadTemplate}
              data-testid="download-template-btn"
            >
              <Download className="w-4 h-4" /> Descarregar modelo
            </Button>
            <input
              ref={templateFileRef}
              type="file"
              accept=".xlsx,.xls"
              onChange={onUploadTemplate}
              className="hidden"
              data-testid="weighins-template-upload-input"
            />
            <Button
              variant="outline"
              className="gap-2"
              onClick={() => templateFileRef.current?.click()}
              disabled={uploadingTemplate}
              data-testid="weighins-template-upload-btn"
            >
              <Upload className="w-4 h-4" /> {uploadingTemplate ? "A enviar..." : "Atualizar modelo"}
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={onUpload}
              className="hidden"
              data-testid="weighins-import-input"
            />
            <Button
              className="gap-2"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              data-testid="weighins-import-btn"
            >
              <Upload className="w-4 h-4" /> {uploading ? "A importar..." : "Importar Excel"}
            </Button>
          </div>
        )}
      </div>

      {/* Sumário */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <Card className="p-4">
          <div className="flex items-center gap-2 text-xs uppercase tracking-widest text-muted-foreground font-semibold">
            <Scale className="w-3.5 h-3.5" /> Atletas
          </div>
          <div className="num text-3xl font-bold mt-1">{athletes.length}</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs uppercase tracking-widest text-muted-foreground font-semibold">Pesagens</div>
          <div className="num text-3xl font-bold mt-1">{totalWeighins}</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs uppercase tracking-widest text-muted-foreground font-semibold">Dias distintos</div>
          <div className="num text-3xl font-bold mt-1">{dates.length}</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs uppercase tracking-widest text-muted-foreground font-semibold">Última pesagem</div>
          <div className="num text-lg font-bold mt-1">
            {dates[0] ? new Date(dates[0]).toLocaleDateString("pt-PT") : "—"}
          </div>
        </Card>
      </div>

      {/* Filtros */}
      <Card className="p-4 mb-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[220px] max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Pesquisar atleta…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="pl-9"
              data-testid="weighins-search"
            />
          </div>
          <Select value={days} onValueChange={setDays}>
            <SelectTrigger className="w-44" data-testid="weighins-days-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7">Últimos 7 dias</SelectItem>
              <SelectItem value="14">Últimos 14 dias</SelectItem>
              <SelectItem value="30">Últimos 30 dias</SelectItem>
              <SelectItem value="60">Últimos 60 dias</SelectItem>
              <SelectItem value="180">Últimos 6 meses</SelectItem>
              <SelectItem value="365">Últimos 12 meses</SelectItem>
            </SelectContent>
          </Select>
          <Select value={deltaFilter} onValueChange={setDeltaFilter}>
            <SelectTrigger className="w-52" data-testid="weighins-delta-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="todos">Todos os atletas</SelectItem>
              <SelectItem value="ganhou">
                Ganharam peso ({deltaCounts.ganhou})
              </SelectItem>
              <SelectItem value="perdeu">
                Perderam peso ({deltaCounts.perdeu})
              </SelectItem>
              <SelectItem value="estavel">
                Peso estável ({deltaCounts.estavel})
              </SelectItem>
            </SelectContent>
          </Select>
          {(q || deltaFilter !== "todos") && (
            <Button variant="ghost" size="sm" onClick={() => { setQ(""); setDeltaFilter("todos"); }} data-testid="weighins-reset-filters">
              Limpar filtros
            </Button>
          )}
          <div className="text-xs text-muted-foreground ml-auto">
            {rows.length} atletas · {dates.length} dias
          </div>
        </div>
      </Card>

      {/* Matriz */}
      <Card className="overflow-hidden">
        {dates.length === 0 ? (
          <div className="p-16 text-center">
            <Scale className="w-10 h-10 mx-auto text-muted-foreground/50 mb-3" />
            <div className="text-lg font-semibold mb-1">Sem pesagens no período seleccionado</div>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              Descarregue o modelo Excel, preencha o peso de cada atleta por dia, e importe. Todos os registos aparecem aqui e no perfil individual de cada atleta.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-secondary/40 text-xs uppercase tracking-widest text-muted-foreground font-semibold sticky top-0">
                <tr>
                  <th className="text-left px-4 py-3 sticky left-0 bg-secondary/40 z-10 min-w-[180px]">Atleta</th>
                  {dates.map((d) => (
                    <th key={d} className="text-right px-3 py-3 whitespace-nowrap">{fmtDate(d)}</th>
                  ))}
                  <th className="text-center px-3 py-3">Perfil</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => {
                  const values = a.values || byAthlete[a.id] || {};
                  const delta = a.delta;
                  return (
                    <tr key={a.id} className="border-t hover:bg-secondary/40 transition" data-testid={`weighin-row-${a.nome.replace(/\s+/g, "-")}`}>
                      <td className="px-4 py-2.5 sticky left-0 bg-card z-10">
                        <div className="font-semibold">{a.nome}</div>
                        {a.posicao && <div className="text-xs text-muted-foreground">{a.posicao}</div>}
                        {delta != null && (
                          <div className={`text-[10px] font-semibold ${delta > 0.1 ? "text-red-500" : delta < -0.1 ? "text-emerald-500" : "text-muted-foreground"}`}>
                            {delta > 0 ? "+" : ""}{delta} kg no período
                          </div>
                        )}
                      </td>
                      {dates.map((d) => {
                        const v = values[d];
                        return (
                          <td key={d} className="px-3 py-2.5 text-right num tabular-nums">
                            {v != null ? <span className="font-semibold">{v}</span> : <span className="text-muted-foreground/40">—</span>}
                          </td>
                        );
                      })}
                      <td className="px-3 py-2.5 text-center">
                        <Button variant="ghost" size="icon" onClick={() => nav(`/atletas/${a.id}`)} title="Abrir perfil">
                          <ArrowRight className="w-4 h-4" />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="mt-4 text-xs text-muted-foreground">
        Formatos aceites: <b>(A)</b> uma linha por pesagem (colunas Nome/Data/Peso) ou <b>(B)</b> uma linha por atleta com as datas em colunas (como no modelo). Re-importar o mesmo dia substitui o valor anterior.
      </div>
    </div>
  );
}
