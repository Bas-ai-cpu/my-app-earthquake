import { NextResponse } from "next/server";

/* ---------- Types ---------- */
type Source = "ds" | "geo";

type UpDevice = {
  source?: Source;
  id: number;
  key: string;
  value: number; // 0=online, 1=offline
  last_online?: string; // ISO
  seq: number; // ลำดับจริงจาก upstream
};

type OldPayload = {
  mode?: string; // "concat"
  order?: "ds_first" | "geo_first";
  prefer?: string;
  hourly_TmStamp_geo?: string;
  hourly_TmStamp_ds?: string;
  summary_TmStamp_geo?: string;
  summary_TmStamp_ds?: string;
  devices: UpDevice[];
};

type ModemItem = {
  source: Source;
  id: number;
  key: string;
  value: number;
  last_online?: string;
  seq: number; // seq จริงของ modem
};

type DeviceOut = {
  source: Source;
  id: number; // id จริงของ device นั้น ๆ
  key: string;
  value: number;
  last_online?: string;
  seq: number; // seq จริงของ device
  modem: ModemItem[];
  id_out?: number; // ใช้ id จริงสำหรับนับสรุป
};

type NewPayload = {
  mode?: string;
  hourly_TmStamp_geo?: string;
  hourly_TmStamp_ds?: string;
  summary_TmStamp_geo?: string;
  summary_TmStamp_ds?: string;

  devices: DeviceOut[]; // ds (seq 17–32) + geo (seq 52–71)

  count_online: number;
  count_offline: number;
  online_ids: number[]; // จาก id_out
  offline_ids: number[]; // จาก id_out
};

/* ---------- CONFIG: ช่วง parent ----------- */
// ds: parent โดย seq
const DS_PARENT_SEQ_RANGE = { start: 17, end: 32 };
// geo: parent โดย seq (เอาถึงแค่ 71 ตามที่บอก)
const GEO_PARENT_SEQ_RANGE = { start: 52, end: 71 };

/* ---------- CONFIG: Mapping แบบ Array (แก้ง่าย/CRUD สบาย) ----------
   ทั้งสองฝั่ง "ใช้ seq" เหมือนกัน:
   - DS: key = parentSeq  -> modemSeqs[]
   - GEO: key = parentSeq -> modemSeqs[]
-------------------------------------------------- */
type DsLink = { parentSeq: number; modemSeqs: number[] };
type GeoLink = { parentSeq: number; modemSeqs: number[] };

// ค่า default เดิมของคุณ:
// ds parent seq 17..32 -> modem seq 1..16
const DS_LINKS: DsLink[] = [
  { parentSeq: 17, modemSeqs: [1] },
  { parentSeq: 18, modemSeqs: [2] },
  { parentSeq: 19, modemSeqs: [3] },
  { parentSeq: 20, modemSeqs: [4] },
  { parentSeq: 21, modemSeqs: [5] },
  { parentSeq: 22, modemSeqs: [6] },
  { parentSeq: 23, modemSeqs: [7] },
  { parentSeq: 24, modemSeqs: [8] },
  { parentSeq: 25, modemSeqs: [9] },
  { parentSeq: 26, modemSeqs: [10] },
  { parentSeq: 27, modemSeqs: [11] },
  { parentSeq: 28, modemSeqs: [12] },
  { parentSeq: 29, modemSeqs: [13] },
  { parentSeq: 30, modemSeqs: [14] },
  { parentSeq: 31, modemSeqs: [15] },
  { parentSeq: 32, modemSeqs: [16] },
  // อนาคตเพิ่มหลายตัวก็ได้ เช่น { parentSeq: 20, modemSeqs: [4,5] }
];

// ต้องการให้ "geo Device 20 จับคู่กับ geo Device 1" (ตามตัวอย่างจริงที่ seq=52→33)
// และไล่ต่อกัน: 21→2, 22→3, ..., 39→20
// ในเชิง seq คือ parent 52..71 -> modem 33..50
const GEO_LINKS: GeoLink[] = [
  { parentSeq: 52, modemSeqs: [33] },
  { parentSeq: 53, modemSeqs: [34] },
  { parentSeq: 54, modemSeqs: [35] },
  { parentSeq: 55, modemSeqs: [36] },
  { parentSeq: 56, modemSeqs: [37] },
  { parentSeq: 57, modemSeqs: [38] },
  { parentSeq: 58, modemSeqs: [39] },
  { parentSeq: 59, modemSeqs: [40] },
  { parentSeq: 60, modemSeqs: [41] },
  { parentSeq: 61, modemSeqs: [42] },
  { parentSeq: 62, modemSeqs: [43] },
  { parentSeq: 63, modemSeqs: [44] },
  { parentSeq: 64, modemSeqs: [45] },
  { parentSeq: 65, modemSeqs: [46] },
  { parentSeq: 66, modemSeqs: [47] },
  { parentSeq: 67, modemSeqs: [48] },
  { parentSeq: 68, modemSeqs: [49] },
  { parentSeq: 69, modemSeqs: [50] },
  { parentSeq: 70, modemSeqs: [51] }, // ถ้าคุณอยากตัด 72 ออก mapping นี้ก็โอเค (ไม่แตะ 72)
  { parentSeq: 71, modemSeqs: [52] },
  // ถ้าอนาคตจะใช้ 72 ด้วย (id 40) ที่มี seq=72 -> modemSeqs น่าจะเป็น [51]
  // { parentSeq: 72, modemSeqs: [51] },
];

/* ---------- Helpers ---------- */
const ts = (s?: string) => (s ? Date.parse(s) || 0 : 0);

function dedupeWithinSource(devs: UpDevice[]): UpDevice[] {
  const byId = new Map<number, UpDevice>();
  for (const d of devs) {
    const prev = byId.get(d.id);
    if (!prev) {
      byId.set(d.id, d);
      continue;
    }
    const pick =
      prev.value !== 0 && d.value === 0
        ? d
        : d.value !== 0 && prev.value === 0
        ? prev
        : ts(d.last_online) > ts(prev.last_online)
        ? d
        : prev;
    byId.set(d.id, pick);
  }
  return [...byId.values()];
}

// แปลง array → index (Map) เพื่อ lookup เร็ว
function buildDsIndex(links: DsLink[]): Map<number, number[]> {
  const m = new Map<number, number[]>();
  for (const { parentSeq, modemSeqs } of links) m.set(parentSeq, modemSeqs);
  return m;
}
function buildGeoIndex(links: GeoLink[]): Map<number, number[]> {
  const m = new Map<number, number[]>();
  for (const { parentSeq, modemSeqs } of links) m.set(parentSeq, modemSeqs);
  return m;
}

/** สร้าง modem จาก mapping แบบ seq ทั้งสองฝั่ง */
function buildModemsFromSeqMaps(
  parent: UpDevice,
  dsSeqMap: Map<number, UpDevice>, // lookup ds ด้วย seq
  geoSeqMap: Map<number, UpDevice>, // lookup geo ด้วย seq
  dsIdx: Map<number, number[]>, // index ของ DS_LINKS
  geoIdx: Map<number, number[]> // index ของ GEO_LINKS
): ModemItem[] {
  if (parent.source === "ds") {
    const targetSeqs = dsIdx.get(parent.seq) ?? [];
    const items = targetSeqs
      .map((s) => dsSeqMap.get(s))
      .filter(Boolean) as UpDevice[];
    return items.map((m) => ({
      source: (m.source ?? "ds") as Source,
      id: m.id,
      key: m.key,
      value: m.value,
      last_online: m.last_online,
      seq: m.seq,
    }));
  }
  // geo
  const targetSeqs = geoIdx.get(parent.seq) ?? [];
  const items = targetSeqs
    .map((s) => geoSeqMap.get(s))
    .filter(Boolean) as UpDevice[];
  return items.map((m) => ({
    source: (m.source ?? "geo") as Source,
    id: m.id,
    key: m.key,
    value: m.value,
    last_online: m.last_online,
    seq: m.seq,
  }));
}

/* ---------- Transform ---------- */
function transform(op: OldPayload): NewPayload {
  // 1) แยก/ dedupe
  const dsUnique = dedupeWithinSource(
    op.devices.filter((d) => d.source === "ds")
  );
  const geoUnique = dedupeWithinSource(
    op.devices.filter((d) => d.source === "geo")
  );

  // 2) ทำ map lookup ด้วย seq
  const dsSeqMap = new Map(dsUnique.map((d) => [d.seq, d]));
  const geoSeqMap = new Map(geoUnique.map((d) => [d.seq, d]));

  // 3) สร้าง index mapping จาก array
  const dsIdx = buildDsIndex(DS_LINKS);
  const geoIdx = buildGeoIndex(GEO_LINKS);

  // 4) เลือก parent ตามช่วง seq
  const dsParents = dsUnique
    .filter(
      (d) =>
        d.seq >= DS_PARENT_SEQ_RANGE.start && d.seq <= DS_PARENT_SEQ_RANGE.end
    )
    .sort((a, b) => a.seq - b.seq); // แก้บั๊กเดิม a.seq - a.seq

  const geoParents = geoUnique
    .filter(
      (d) =>
        d.seq >= GEO_PARENT_SEQ_RANGE.start && d.seq <= GEO_PARENT_SEQ_RANGE.end
    )
    .sort((a, b) => a.seq - b.seq);

  // 5) ประกอบผลลัพธ์ + เติม modem (seq-based) + id_out=id
  const dsOut: DeviceOut[] = dsParents.map((p) => ({
    source: (p.source ?? "ds") as Source,
    id: p.id,
    key: p.key,
    value: p.value,
    last_online: p.last_online,
    seq: p.seq,
    modem: buildModemsFromSeqMaps(p, dsSeqMap, geoSeqMap, dsIdx, geoIdx),
    id_out: p.id,
  }));

  const geoOut: DeviceOut[] = geoParents.map((p) => ({
    source: (p.source ?? "geo") as Source,
    id: p.id,
    key: p.key,
    value: p.value,
    last_online: p.last_online,
    seq: p.seq,
    modem: buildModemsFromSeqMaps(p, dsSeqMap, geoSeqMap, dsIdx, geoIdx),
    id_out: p.id,
  }));

  const devices = [...dsOut, ...geoOut];

  // 6) นับสรุปจาก id_out
  const online_ids: number[] = [];
  const offline_ids: number[] = [];
  for (const dv of devices)
    (dv.value === 0 ? online_ids : offline_ids).push(dv.id_out!);

  return {
    mode: op.mode,
    hourly_TmStamp_geo: op.hourly_TmStamp_geo,
    hourly_TmStamp_ds: op.hourly_TmStamp_ds,
    summary_TmStamp_geo: op.summary_TmStamp_geo,
    summary_TmStamp_ds: op.summary_TmStamp_ds,
    devices,
    count_online: online_ids.length,
    count_offline: offline_ids.length,
    online_ids,
    offline_ids,
  };
}

/* ---------- Handler ---------- */
export async function GET() {
  try {
    const url =
      process.env.API_DEVICES_URL ??
      "https://apii-2.cloud-dbms.com/api/devices/latest-merged?order=ds_first&mode=concat";

    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Upstream HTTP ${res.status} ${res.statusText} :: ${text}`
      );
    }

    const json = (await res.json()) as OldPayload;
    const out = transform(json);
    return NextResponse.json(out, { status: 200 });
  } catch (err: any) {
    console.error("[/api/devices] error:", err?.message ?? err);
    return NextResponse.json(
      { error: "transform-failed", detail: err?.message ?? "unknown" },
      { status: 502 }
    );
  }
}
