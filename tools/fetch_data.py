"""Fetch all real data for the Lunar Landing Site Navigator.

    pip install -r tools/requirements.txt
    python tools/fetch_data.py

Runs the terrain fetcher, then the resource fetcher (if present). One failing does not stop the
other. Layers that could not be fetched stay as synthetic demo layers (flagged in the manifest,
so the site keeps showing its "demo data" warning).
"""
import importlib
import os
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def run(module_name):
    try:
        mod = importlib.import_module(module_name)
    except ModuleNotFoundError as e:
        if e.name == module_name:
            return "skipped (tools/%s.py not present)" % module_name
        traceback.print_exc()
        return "FAILED (missing dependency: %s - run: pip install -r tools/requirements.txt)" % e.name
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        return "FAILED on import (%s)" % e
    try:
        mod.main()
        return "ok"
    except SystemExit as e:
        return "ok" if e.code in (0, None) else "FAILED (exit %s)" % (e.code,)
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        return "FAILED (%s)" % (str(e).splitlines()[0] if str(e) else type(e).__name__)


def main():
    results = {}
    for name in ("fetch_terrain", "fetch_resources"):
        print("\n=== %s ===" % name)
        results[name] = run(name)

    print("\n=== summary ===")
    for name, res in results.items():
        print("  %-16s %s" % (name, res))
    try:
        import common
        m = common.load_manifest()
        for layer in m.get("layers", []):
            print("  layer %-6s %-28s %s" % (layer["id"], layer.get("mission", ""),
                                            "DEMO (synthetic)" if layer.get("demo") else "real"))
        print("  manifest demo flag: %s" % m.get("demo"))
        if m.get("demo"):
            print("  NOTE: some layers are still synthetic; the site will show its demo-data warning.")
    except Exception as e:  # noqa: BLE001
        print("  (could not read manifest: %s)" % e)
    return 0 if all(r == "ok" or r.startswith("skipped") for r in results.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
