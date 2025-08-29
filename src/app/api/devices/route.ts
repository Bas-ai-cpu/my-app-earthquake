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
const GEO_PARENT_SEQ_RANGE = { start: 53, end: 72 };

/* ---------- CONFIG: Mapping แบบ Array เดียว (ds + geo) ---------- */
type Link = { source: Source; parentSeq: number; modemSeqs: number[] };

const LINKS: Link[] = [
  // ds: parent seq 17..32 -> modem seq 1..16
  { source: "ds", parentSeq: 17, modemSeqs: [1] },
  { source: "ds", parentSeq: 18, modemSeqs: [2] },
  { source: "ds", parentSeq: 19, modemSeqs: [3] },
  { source: "ds", parentSeq: 20, modemSeqs: [4] },
  { source: "ds", parentSeq: 21, modemSeqs: [5] },
  { source: "ds", parentSeq: 22, modemSeqs: [6] },
  { source: "ds", parentSeq: 23, modemSeqs: [7] },
  { source: "ds", parentSeq: 24, modemSeqs: [8] },
  { source: "ds", parentSeq: 25, modemSeqs: [9] },
  { source: "ds", parentSeq: 26, modemSeqs: [10] },
  { source: "ds", parentSeq: 27, modemSeqs: [11] },
  { source: "ds", parentSeq: 28, modemSeqs: [12] },
  { source: "ds", parentSeq: 29, modemSeqs: [13] },
  { source: "ds", parentSeq: 30, modemSeqs: [14] },
  { source: "ds", parentSeq: 31, modemSeqs: [15] },
  { source: "ds", parentSeq: 32, modemSeqs: [16] },

  // geo: parent seq 52..71 -> modem seq 33..52
  // (ตัวอย่างที่คุณต้องการ: geo Device 20 (seq=52) คู่กับ geo Device 1 (seq=33))
  { source: "geo", parentSeq: 53, modemSeqs: [33] },
  { source: "geo", parentSeq: 54, modemSeqs: [34] },
  { source: "geo", parentSeq: 55, modemSeqs: [35] },
  { source: "geo", parentSeq: 56, modemSeqs: [36] },
  { source: "geo", parentSeq: 57, modemSeqs: [37] },
  { source: "geo", parentSeq: 58, modemSeqs: [38] },
  { source: "geo", parentSeq: 59, modemSeqs: [39] },
  { source: "geo", parentSeq: 60, modemSeqs: [40] },
  { source: "geo", parentSeq: 61, modemSeqs: [41] },
  { source: "geo", parentSeq: 62, modemSeqs: [42] },
  { source: "geo", parentSeq: 63, modemSeqs: [43] },
  { source: "geo", parentSeq: 64, modemSeqs: [44] },
  { source: "geo", parentSeq: 65, modemSeqs: [45] },
  { source: "geo", parentSeq: 66, modemSeqs: [46] },
  { source: "geo", parentSeq: 67, modemSeqs: [47] },
  { source: "geo", parentSeq: 68, modemSeqs: [48] },
  { source: "geo", parentSeq: 69, modemSeqs: [49] },
  { source: "geo", parentSeq: 70, modemSeqs: [50] },
  { source: "geo", parentSeq: 71, modemSeqs: [51] },
  { source: "geo", parentSeq: 72, modemSeqs: [52] },
  // จะเพิ่มหลาย modem ก็ทำได้ เช่น { source:"geo", parentSeq: 60, modemSeqs:[41,42] }
];

/* ---------- Index: Array → Map<source, Map<parentSeq, modemSeqs[]>> ---------- */
function buildLinkIndex(links: Link[]): Map<Source, Map<number, number[]>> {
  const idx = new Map<Source, Map<number, number[]>>();
  idx.set("ds", new Map());
  idx.set("geo", new Map());
  for (const { source, parentSeq, modemSeqs } of links) {
    const inner = idx.get(source)!;
    inner.set(parentSeq, modemSeqs);
  }
  return idx;
}

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
// function buildDsIndex(links: DsLink[]): Map<number, number[]> {
//   const m = new Map<number, number[]>();
//   for (const { parentSeq, modemSeqs } of links) m.set(parentSeq, modemSeqs);
//   return m;
// }
// function buildGeoIndex(links: GeoLink[]): Map<number, number[]> {
//   const m = new Map<number, number[]>();
//   for (const { parentSeq, modemSeqs } of links) m.set(parentSeq, modemSeqs);
//   return m;
// }

/* ---------- ใช้ index เดียว lookup ได้ทั้ง ds/geo (จับคู่ด้วย seq เหมือนกัน) ---------- */
function buildModemsFromSeqMaps(
  parent: UpDevice,
  dsSeqMap: Map<number, UpDevice>,   // lookup ds ด้วย seq
  geoSeqMap: Map<number, UpDevice>,  // lookup geo ด้วย seq
  linkIdx: Map<Source, Map<number, number[]>>,
): ModemItem[] {
  const src = (parent.source ?? "ds") as Source;
  const inner = linkIdx.get(src) ?? new Map<number, number[]>();
  const targetSeqs = inner.get(parent.seq) ?? [];
  const map = src === "geo" ? geoSeqMap : dsSeqMap;

  const items = targetSeqs.map(s => map.get(s)).filter(Boolean) as UpDevice[];
  return items.map(m => ({
    source: (m.source ?? src) as Source,
    id: m.id,
    key: m.key,
    value: m.value,
    last_online: m.last_online,
    seq: m.seq,
  }));
}

/* ---------- Transform ---------- */
function transform(op: OldPayload): NewPayload {
  const dsUnique = dedupeWithinSource(op.devices.filter(d => d.source === "ds"));
  const geoUnique = dedupeWithinSource(op.devices.filter(d => d.source === "geo"));

  const dsSeqMap = new Map(dsUnique.map(d => [d.seq, d]));
  const geoSeqMap = new Map(geoUnique.map(d => [d.seq, d]));

  // ✅ สร้าง index เดียวจาก LINKS
  const linkIdx = buildLinkIndex(LINKS);

  const dsParents = dsUnique
    .filter(d => d.seq >= DS_PARENT_SEQ_RANGE.start && d.seq <= DS_PARENT_SEQ_RANGE.end)
    .sort((a, b) => a.seq - b.seq);
  const geoParents = geoUnique
    .filter(d => d.seq >= GEO_PARENT_SEQ_RANGE.start && d.seq <= GEO_PARENT_SEQ_RANGE.end)
    .sort((a, b) => a.seq - b.seq);

  const dsOut: DeviceOut[] = dsParents.map(p => ({
    source: (p.source ?? "ds") as Source,
    id: p.id, key: p.key, value: p.value, last_online: p.last_online, seq: p.seq,
    modem: buildModemsFromSeqMaps(p, dsSeqMap, geoSeqMap, linkIdx),
    id_out: p.id,
  }));

  const geoOut: DeviceOut[] = geoParents.map(p => ({
    source: (p.source ?? "geo") as Source,
    id: p.id, key: p.key, value: p.value, last_online: p.last_online, seq: p.seq,
    modem: buildModemsFromSeqMaps(p, dsSeqMap, geoSeqMap, linkIdx),
    id_out: p.id,
  }));

  const devices = [...dsOut, ...geoOut];

  const online_ids: number[] = [];
  const offline_ids: number[] = [];
  for (const dv of devices) (dv.value === 0 ? online_ids : offline_ids).push(dv.id_out!);

  return {
    mode: op.mode,
    hourly_TmStamp_geo: op.hourly_TmStamp_geo,
    hourly_TmStamp_ds: op.hourly_TmStamp_ds,
    summary_TmStamp_geo: op.summary_TmStamp_geo,
    summary_TmStamp_ds: op.summary_TmStamp_ds,
    devices,
    count_online: online_ids.length,
    count_offline: offline_ids.length,
    online_ids, offline_ids,
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
