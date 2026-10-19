"""Carga/actualiza bots de grilla desde un snapshot JSON a data/db.json.

Uso:  py tools/cargar_bots.py [data/pionex-snapshot.json] [id_cartera]

- Crea la cartera (tipo "bots") si no existe.
- Bots que ya estaban (mismo externalId) se actualizan; los nuevos se agregan.
- Bots activos en la app que ya no aparecen en el snapshot se marcan como finalizados
  con su último valor conocido.
"""
import datetime
import json
import os
import shutil
import sys
import uuid

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(BASE, "data", "db.json")


def main():
    snap_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(BASE, "data", "pionex-snapshot.json")
    pid = sys.argv[2] if len(sys.argv) > 2 else "bots-pionex"
    with open(snap_path, encoding="utf-8") as f:
        snap = json.load(f)
    with open(DB_PATH, encoding="utf-8") as f:
        db = json.load(f)
    shutil.copy(DB_PATH, DB_PATH.replace("db.json", "db.antes-de-importar.json"))

    if not any(p["id"] == pid for p in db["portfolios"]):
        used = {p.get("slot") for p in db["portfolios"]}
        db["portfolios"].append({"id": pid, "name": f"Bots {snap['exchange']}", "type": "bots",
                                 "broker": snap["exchange"], "slot": next(s for s in range(1, 9) if s not in used)})

    bots = db.setdefault("bots", [])
    by_ext = {b.get("externalId"): b for b in bots if b.get("portfolioId") == pid}
    seen = set()
    for s in snap["bots"]:
        seen.add(s["externalId"])
        rec = by_ext.get(s["externalId"]) or {"id": uuid.uuid4().hex[:10], "portfolioId": pid, "note": ""}
        rec.update({
            "externalId": s["externalId"], "exchange": snap["exchange"], "pair": s["pair"], "kind": s["kind"],
            "trend": s.get("trend"), "leverage": s.get("leverage", 1), "range": s.get("range"), "grids": s.get("grids"),
            "start": datetime.datetime.fromtimestamp(s["created"] / 1000).date().isoformat(),
            "status": "running", "end": None,
            "invested": s["invested"], "profit": s["profit"],
            "gridProfit": s.get("gridProfit"), "gridProfit24h": s.get("gridProfit24h"),
            "entryPrice": s.get("entryPrice"), "liqDown": s.get("liqDown"), "liqUp": s.get("liqUp"),
            "copy": s.get("copy"), "updated": snap["fecha"],
        })
        if rec["id"] not in {b["id"] for b in bots}:
            bots.append(rec)
    for b in bots:
        if b.get("portfolioId") == pid and b.get("externalId") and b["externalId"] not in seen and b["status"] == "running":
            b["status"], b["end"] = "finished", snap["fecha"]

    with open(DB_PATH, "w", encoding="utf-8") as f:
        json.dump(db, f, ensure_ascii=False, indent=2)
    print(f"{len(snap['bots'])} bots cargados en '{pid}'")


if __name__ == "__main__":
    main()
