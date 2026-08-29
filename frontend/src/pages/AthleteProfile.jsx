import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { api, formatApiError, API } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusPill } from "@/components/StatusPill";
import { AthleteForm } from "@/components/AthleteForm";
import { EvaluationForm } from "@/components/EvaluationForm";
import { EvaluationCharts } from "@/components/EvaluationCharts";
import { EvaluationHistoryRow } from "@/components/EvaluationHistoryRow";
import { WeighinsPanel } from "@/components/WeighinsPanel";
import { PhotosPanel } from "@/components/PhotosPanel";
import { GoalsPanel } from "@/components/GoalsPanel";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { ArrowLeft, Pencil, Trash2, Plus, FileDown, Mail } from "lucide-react";
import { AthleteAvatar } from "@/components/AthleteAvatar";
import { exportAthletePdf } from "@/lib/pdf";
import { SendReportDialog } from "@/components/SendReportDialog";

export default function AthleteProfile() {
  const { id } = useParams();
  const nav = useNavigate();
  const { isEditor } = useAuth();
  const [athlete, setAthlete] = useState(null);
  const [evals, setEvals] = useState([]);
  const [weighins, setWeighins] = useState([]);
  const [editOpen, setEditOpen] = useState(false);
  const [newEvalOpen, setNewEvalOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);

  const reload = async () => {
    const a = await api.get(`/athletes/${id}`);
    setAthlete(a.data);
    const e = await api.get(`/athletes/${id}/evaluations`);
    setEvals(e.data);
    const w = await api.get(`/athletes/${id}/weighins`);
    setWeighins(w.data);
  };

  useEffect(() => { reload(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!athlete) return <div className="p-8">A carregar…</div>;

  const last = evals[evals.length - 1];
  const metrics = last?.metrics;

  const doDelete = async () => {
    try {
      await api.delete(`/athletes/${id}`);
      toast.success("Atleta apagado");
      nav("/");
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    }
  };

  const updateAthlete = async (vals) => {
    try {
      const { data } = await api.put(`/athletes/${id}`, vals);
      setAthlete(data);
      toast.success("Atleta atualizado");
      setEditOpen(false);
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    }
  };

  return (
    <div className="p-8 max-w-[1400px] mx-auto">
      <button className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1 mb-4" onClick={() => nav("/")} data-testid="back-btn">
        <ArrowLeft className="w-4 h-4" /> Voltar
      </button>

      {/* Header */}
      <Card className="p-6 mb-6">
        <div className="flex flex-wrap justify-between gap-4">
          <div className="flex items-start gap-5">
            <AthleteAvatar athleteId={id} isEditor={isEditor} size={104} />
            <div>
              <div className="text-xs uppercase tracking-widest text-muted-foreground font-semibold">{athlete.posicao || "Atleta"}</div>
              <h1 className="font-display text-5xl font-bold tracking-tighter mt-1" data-testid="athlete-header-name">
                {athlete.nome}
              </h1>
              <div className="mt-2 flex items-center gap-3">
                <StatusPill status={metrics?.status} testid="header-status" />
                <span className="text-sm text-muted-foreground">
                  {athlete.sexo === "M" ? "Masc." : "Fem."} · {athlete.idade || "—"} anos · {athlete.altura_cm || "—"} cm
                </span>
              </div>
            </div>
          </div>
          <div className="flex gap-2 flex-wrap">
            <Button
              variant="outline"
              className="gap-2"
              data-testid="download-athlete-pdf"
              onClick={() => exportAthletePdf(athlete, evals, weighins)}
            >
              <FileDown className="w-4 h-4" /> Descarregar PDF
            </Button>
            {isEditor && (
              <Button
                variant="outline"
                className="gap-2"
                data-testid="send-report-btn"
                onClick={() => setSendOpen(true)}
              >
                <Mail className="w-4 h-4" /> Enviar por email
              </Button>
            )}
            {isEditor && (
              <>
                <Dialog open={editOpen} onOpenChange={setEditOpen}>
                  <DialogTrigger asChild>
                    <Button variant="outline" data-testid="edit-athlete-btn"><Pencil className="w-4 h-4 mr-2" />Editar</Button>
                  </DialogTrigger>
                  <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
                    <DialogHeader><DialogTitle>Editar atleta</DialogTitle></DialogHeader>
                    <AthleteForm initial={athlete} onSubmit={updateAthlete} />
                  </DialogContent>
                </Dialog>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="destructive" data-testid="delete-athlete-btn"><Trash2 className="w-4 h-4 mr-2" />Apagar</Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Apagar {athlete.nome}?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Esta ação apaga o atleta e todo o seu histórico (avaliações, pesagens e fotos). Não é reversível.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancelar</AlertDialogCancel>
                      <AlertDialogAction onClick={doDelete} data-testid="confirm-delete-athlete">Apagar</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </>
            )}
          </div>
        </div>

        {/* KPIs */}
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3 mt-6">
          <Kpi label="Peso" value={last?.peso_kg ?? athlete.peso_atual_kg} unit="kg" testid="kpi-peso" />
          <Kpi label="% MG (R&W)" value={metrics?.rw} unit="%" testid="kpi-mg" />
          <Kpi label="Massa Gorda" value={metrics?.fat_mass_kg} unit="kg" testid="kpi-mg-kg" />
          <Kpi label="Massa Magra" value={metrics?.lean_mass_kg} unit="kg" testid="kpi-lean" />
          <Kpi label="Massa Muscular" value={metrics?.muscle_mass_kg} unit="kg" testid="kpi-mm" />
          <Kpi label="MM/MG" value={metrics?.mm_mg_ratio} testid="kpi-mmmg" />
          <Kpi label="IMC" value={metrics?.imc} testid="kpi-imc" />
          <Kpi label="Σ 8 pregas" value={metrics?.soma8 != null ? Math.round(metrics.soma8) : null} unit="mm" testid="kpi-soma8" />
        </div>
        {metrics && (
          <div className="mt-6 pt-6 border-t">
            <div className="text-xs uppercase tracking-widest text-muted-foreground font-semibold mb-3">
              Comparativo entre métodos · % Massa Gorda
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm border rounded-md overflow-hidden" data-testid="methods-table">
                <thead className="bg-secondary/40 text-xs uppercase tracking-widest text-muted-foreground font-semibold">
                  <tr>
                    <th className="text-left px-4 py-2.5">Método</th>
                    <th className="text-right px-4 py-2.5">% Massa Gorda</th>
                    <th className="text-left px-4 py-2.5 hidden md:table-cell">Fonte / Notas</th>
                  </tr>
                </thead>
                <tbody>
                  <MethodRow label="Reilly & Wallace" value={metrics.rw} note="Referência do departamento médico" highlight />
                  <MethodRow label="Jackson-Pollock 7" value={metrics.jp7} note="7 pregas · fórmula generalizada" />
                  <MethodRow label="Evans 7" value={metrics.evans7} note="Sensível à etnia · 7 pregas" />
                  <MethodRow label="Evans 3" value={metrics.evans3} note="Sensível à etnia · 3 pregas" />
                  <MethodRow label="Withers" value={metrics.withers} note="Densidade corporal · 7 pregas" />
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Card>

      <Tabs defaultValue="avaliacoes">
        <TabsList className="mb-4">
          <TabsTrigger value="avaliacoes" data-testid="tab-avaliacoes">Avaliações</TabsTrigger>
          <TabsTrigger value="pesagens" data-testid="tab-pesagens">Pesagens</TabsTrigger>
          <TabsTrigger value="fotos" data-testid="tab-fotos">Fotos</TabsTrigger>
          <TabsTrigger value="objetivos" data-testid="tab-objetivos">Objetivos</TabsTrigger>
        </TabsList>

        <TabsContent value="avaliacoes" className="space-y-6">
          {evals.length > 1 && (
            <Card className="p-6">
              <h3 className="font-display text-xl font-bold mb-4">Evolução</h3>
              <EvaluationCharts evals={evals} />
            </Card>
          )}
          <Card className="p-6">
            <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
              <h3 className="font-display text-xl font-bold">Histórico ({evals.length})</h3>
              {isEditor && (
                <Dialog open={newEvalOpen} onOpenChange={setNewEvalOpen}>
                  <DialogTrigger asChild>
                    <Button data-testid="new-eval-btn" className="gap-2">
                      <Plus className="w-4 h-4" /> Registar avaliação
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
                    <DialogHeader>
                      <DialogTitle>Nova avaliação · {athlete.nome}</DialogTitle>
                    </DialogHeader>
                    <EvaluationForm
                      athlete={athlete}
                      onSaved={() => { setNewEvalOpen(false); reload(); }}
                    />
                  </DialogContent>
                </Dialog>
              )}
            </div>
            {evals.length === 0 ? (
              <p className="text-muted-foreground text-sm">Sem avaliações registadas.</p>
            ) : (
              <div className="space-y-2">
                {[...evals].reverse().map((e) => (
                  <EvaluationHistoryRow
                    key={e.id}
                    evaluation={e}
                    athlete={athlete}
                    isEditor={isEditor}
                    onDelete={async (id) => {
                      await api.delete(`/evaluations/${id}`);
                      reload();
                    }}
                    onEdited={reload}
                  />
                ))}
              </div>
            )}
          </Card>
        </TabsContent>

        <TabsContent value="pesagens">
          <WeighinsPanel athleteId={id} weighins={weighins} onChange={reload} isEditor={isEditor} />
        </TabsContent>

        <TabsContent value="fotos">
          <PhotosPanel athleteId={id} evaluations={evals} isEditor={isEditor} />
        </TabsContent>

        <TabsContent value="objetivos">
          <GoalsPanel athlete={athlete} evaluations={evals} onSaved={reload} isEditor={isEditor} />
        </TabsContent>
      </Tabs>

      <SendReportDialog
        open={sendOpen}
        onOpenChange={setSendOpen}
        athlete={athlete}
        evals={evals}
        weighins={weighins}
      />
    </div>
  );
}

function Kpi({ label, value, unit, testid }) {
  return (
    <div data-testid={testid}>
      <div className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">{label}</div>
      <div className="mt-1 font-display font-bold tracking-tighter num text-3xl">
        {value ?? "—"}
        {value != null && unit ? <span className="text-lg text-muted-foreground ml-1">{unit}</span> : null}
      </div>
    </div>
  );
}

function MethodBox({ label, value }) {
  return (
    <div className="p-3 rounded-md border bg-secondary/40">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">{label}</div>
      <div className="num font-display text-2xl font-bold">{value ?? "—"}<span className="text-sm text-muted-foreground">%</span></div>
    </div>
  );
}

function MethodRow({ label, value, note, highlight }) {
  return (
    <tr className={`border-t ${highlight ? "bg-primary/5" : ""}`}>
      <td className="px-4 py-2.5">
        <span className={`font-semibold ${highlight ? "text-primary" : ""}`}>{label}</span>
        {highlight && <span className="ml-2 text-[10px] uppercase tracking-wider text-primary font-bold">Ref.</span>}
      </td>
      <td className="px-4 py-2.5 text-right num font-display font-bold text-lg">
        {value ?? "—"}<span className="text-xs text-muted-foreground ml-0.5">%</span>
      </td>
      <td className="px-4 py-2.5 text-xs text-muted-foreground hidden md:table-cell">{note}</td>
    </tr>
  );
}
