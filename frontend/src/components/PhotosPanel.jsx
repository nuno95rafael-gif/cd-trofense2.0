import { useEffect, useMemo, useRef, useState } from "react";
import { api, formatApiError, API } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Upload, X, Crop, Move } from "lucide-react";
import { toast } from "sonner";
import { PhotoCropDialog } from "@/components/PhotoCropDialog";

const KINDS = [
  { key: "frontal", label: "Frente" },
  { key: "perfil", label: "Perfil" },
  { key: "costas", label: "Costas" },
];

export function PhotosPanel({ athleteId, evaluations, isEditor }) {
  const [photos, setPhotos] = useState([]);
  const [blobs, setBlobs] = useState({}); // id -> object url
  const [selectedDate, setSelectedDate] = useState(null);

  // Crop dialog state
  const [cropSrc, setCropSrc] = useState(null);
  const [pendingUpload, setPendingUpload] = useState(null); // { file, kind, date, evaluation_id } or { pid } for replace
  const fileRefs = useRef({}); // key: `${date}-${kind}` -> input

  const evalDates = useMemo(() => {
    const s = new Set((evaluations || []).map((e) => e.date));
    return Array.from(s).sort();
  }, [evaluations]);

  useEffect(() => {
    if (evalDates.length && !selectedDate) setSelectedDate(evalDates[evalDates.length - 1]);
  }, [evalDates, selectedDate]);

  const load = async () => {
    const { data } = await api.get(`/athletes/${athleteId}/photos`);
    setPhotos(data);
    const token = localStorage.getItem("trofense_token");
    const newBlobs = {};
    for (const p of data) {
      try {
        const res = await fetch(`${API}/photos/${p.id}/download`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const b = await res.blob();
        newBlobs[p.id] = URL.createObjectURL(b);
      } catch { /* skip */ }
    }
    setBlobs((old) => {
      Object.values(old).forEach((u) => URL.revokeObjectURL(u));
      return newBlobs;
    });
  };

  useEffect(() => { load(); }, [athleteId]); // eslint-disable-line react-hooks/exhaustive-deps

  const photosByDateKind = useMemo(() => {
    const map = {};
    photos.forEach((p) => {
      if (p.kind === "profile") return; // profile avatar não conta nas fotos por avaliação
      map[p.date] = map[p.date] || {};
      map[p.date][p.kind] = p;
    });
    return map;
  }, [photos]);

  // Para cada slot (frontal/perfil/costas) na data selecionada, se não houver
  // foto própria, procura a mais recente das datas anteriores. Devolve
  // { photo, inheritedFromDate | null }.
  const resolveSlot = (kind) => {
    if (!selectedDate) return { photo: null, inheritedFromDate: null };
    const own = photosByDateKind[selectedDate]?.[kind];
    if (own) return { photo: own, inheritedFromDate: null };
    const olderDates = Object.keys(photosByDateKind)
      .filter((d) => d < selectedDate)
      .sort()
      .reverse();
    for (const d of olderDates) {
      if (photosByDateKind[d]?.[kind]) {
        return { photo: photosByDateKind[d][kind], inheritedFromDate: d };
      }
    }
    return { photo: null, inheritedFromDate: null };
  };

  const currentEvaluation = useMemo(
    () => evaluations?.find((e) => e.date === selectedDate),
    [evaluations, selectedDate]
  );

  const openFilePicker = (kind) => {
    const key = `${selectedDate}-${kind}`;
    fileRefs.current[key]?.click();
  };

  const onFileSelected = (kind) => (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    setCropSrc(url);
    setPendingUpload({
      file,
      kind,
      date: selectedDate,
      evaluation_id: currentEvaluation?.id,
      mode: "create",
    });
    e.target.value = "";
  };

  const onCropped = async (blob) => {
    if (!pendingUpload) return;
    URL.revokeObjectURL(cropSrc);
    setCropSrc(null);
    const { mode } = pendingUpload;
    try {
      if (mode === "create") {
        const fd = new FormData();
        fd.append("file", new File([blob], "photo.jpg", { type: "image/jpeg" }));
        fd.append("date", pendingUpload.date);
        fd.append("kind", pendingUpload.kind);
        if (pendingUpload.evaluation_id) fd.append("evaluation_id", pendingUpload.evaluation_id);
        await api.post(`/athletes/${athleteId}/photos`, fd, {
          headers: { "Content-Type": "multipart/form-data" },
        });
        toast.success("Foto guardada");
      } else if (mode === "replace") {
        const fd = new FormData();
        fd.append("file", new File([blob], "photo.jpg", { type: "image/jpeg" }));
        await api.put(`/photos/${pendingUpload.pid}/replace`, fd, {
          headers: { "Content-Type": "multipart/form-data" },
        });
        toast.success("Foto atualizada");
      }
      load();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail));
    } finally {
      setPendingUpload(null);
    }
  };

  const startRecrop = async (p) => {
    // Fetch current photo as blob then feed to crop dialog
    try {
      const token = localStorage.getItem("trofense_token");
      const res = await fetch(`${API}/photos/${p.id}/download`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const b = await res.blob();
      const url = URL.createObjectURL(b);
      setCropSrc(url);
      setPendingUpload({ pid: p.id, mode: "replace" });
    } catch (e) {
      toast.error("Falha a carregar imagem para recortar");
    }
  };

  const changeKind = async (p, newKind) => {
    try {
      await api.patch(`/photos/${p.id}`, { kind: newKind });
      load();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail));
    }
  };

  const del = async (p) => {
    await api.delete(`/photos/${p.id}`);
    load();
  };

  return (
    <div className="space-y-6">
      <Card className="p-6">
        <div className="flex flex-wrap items-end justify-between gap-4 mb-4">
          <div>
            <h3 className="font-display text-xl font-bold">Fotos de evolução</h3>
            <p className="text-xs text-muted-foreground mt-1">Fotos associadas a cada avaliação</p>
          </div>
          <div>
            <Label className="text-xs mb-1 block">Avaliação</Label>
            <Select value={selectedDate || ""} onValueChange={setSelectedDate}>
              <SelectTrigger className="w-56" data-testid="photos-eval-selector"><SelectValue placeholder="Escolher avaliação" /></SelectTrigger>
              <SelectContent>
                {evalDates.length === 0 && <SelectItem value="_none" disabled>Sem avaliações</SelectItem>}
                {evalDates.map((d) => (
                  <SelectItem key={d} value={d}>
                    {new Date(d).toLocaleDateString("pt-PT", { day: "2-digit", month: "long", year: "numeric" })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {!selectedDate ? (
          <p className="text-muted-foreground text-sm">Registe uma avaliação para poder adicionar fotos.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {KINDS.map(({ key, label }) => {
              const { photo, inheritedFromDate } = resolveSlot(key);
              const isInherited = !!inheritedFromDate;
              const inputKey = `${selectedDate}-${key}`;
              return (
                <div key={key} className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold">{label}</span>
                    {isEditor && photo && !isInherited && (
                      <Select value={photo.kind} onValueChange={(v) => v !== photo.kind && changeKind(photo, v)}>
                        <SelectTrigger className="h-7 w-24 text-xs" data-testid={`photo-kind-${key}`}>
                          <Move className="w-3 h-3 mr-1" />
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {KINDS.map((k) => <SelectItem key={k.key} value={k.key}>{k.label}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                  <div
                    className={`relative rounded-md overflow-hidden border ${isInherited ? "border-dashed" : ""}`}
                    style={{ aspectRatio: "3 / 4", backgroundColor: "hsl(var(--background))" }}
                  >
                    {photo && blobs[photo.id] ? (
                      <>
                        <img src={blobs[photo.id]} alt={label} className={`w-full h-full object-contain ${isInherited ? "opacity-80" : ""}`} />
                        {isInherited && (
                          <div className="absolute bottom-0 inset-x-0 bg-black/60 text-white text-[10px] uppercase tracking-widest px-2 py-1 text-center">
                            De {new Date(inheritedFromDate).toLocaleDateString("pt-PT", { day: "2-digit", month: "2-digit", year: "2-digit" })}
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="w-full h-full flex flex-col items-center justify-center text-muted-foreground text-xs gap-2">
                        {isEditor ? (
                          <>
                            <Upload className="w-8 h-8 opacity-50" />
                            <span>Sem foto</span>
                          </>
                        ) : (
                          <span>—</span>
                        )}
                      </div>
                    )}
                    {isEditor && photo && !isInherited && (
                      <div className="absolute top-2 right-2 flex gap-1">
                        <Button size="icon" variant="secondary" onClick={() => startRecrop(photo)} title="Recortar" data-testid={`recrop-${photo.id}`}>
                          <Crop className="w-4 h-4" />
                        </Button>
                        <Button size="icon" variant="destructive" onClick={() => del(photo)} title="Remover" data-testid={`del-photo-${photo.id}`}>
                          <X className="w-4 h-4" />
                        </Button>
                      </div>
                    )}
                  </div>
                  {isEditor && (
                    <>
                      <input
                        ref={(el) => (fileRefs.current[inputKey] = el)}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={onFileSelected(key)}
                        data-testid={`photo-input-${key}`}
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full gap-2"
                        onClick={() => openFilePicker(key)}
                        data-testid={`upload-${key}-btn`}
                      >
                        <Upload className="w-4 h-4" />
                        {isInherited ? "Adicionar nova" : (photo ? "Substituir" : "Adicionar foto")}
                      </Button>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <PhotoCropDialog
        open={!!cropSrc}
        src={cropSrc}
        onCancel={() => {
          if (cropSrc) URL.revokeObjectURL(cropSrc);
          setCropSrc(null);
          setPendingUpload(null);
        }}
        onCropped={onCropped}
      />
    </div>
  );
}
