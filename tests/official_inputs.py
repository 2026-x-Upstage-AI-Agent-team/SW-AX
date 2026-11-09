from pathlib import Path
from zipfile import ZipFile

DATASET = Path(__file__).resolve().parents[1] / "test case" / "upstage_data"
ARCHIVE = DATASET.with_suffix(".zip")


def fixture_slot(name):
    """Requested fixture slot; set05's C file actually contains a second consent form."""
    return {"A": "01", "B": "02", "C": "03"}[name.split("_")[1]]


def official_files(case, directory=DATASET):
    if case not in {f"set{i:02}" for i in range(1, 21)}:
        raise ValueError(f"최종 데이터셋의 세트 ID를 확인하세요: {case}")
    archive = directory.with_suffix(".zip")
    if archive.is_file():
        with ZipFile(archive) as source:
            entries = sorted(n for n in source.namelist() if Path(n).parent.parts == (directory.name, case)
                             and Path(n).suffix.lower() in (".hwp", ".hwpx"))
            if not entries:
                raise FileNotFoundError(f"{archive.name}에 {case} 제출 파일이 없습니다.")
            return [(Path(n).name, source.read(n)) for n in entries]
    return [(p.name, p.read_bytes()) for p in sorted((directory / case).iterdir())
            if p.is_file() and p.suffix.lower() in (".hwp", ".hwpx")]
