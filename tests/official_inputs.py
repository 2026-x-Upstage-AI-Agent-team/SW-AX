from pathlib import Path
from zipfile import ZipFile


def official_files(case):
    root = Path(__file__).resolve().parents[1] / "test case" / "유잇_미션2_테스트set"
    archive = root.with_suffix(".zip")
    if archive.is_file():
        with ZipFile(archive) as source:
            return [(Path(n).name,source.read(n)) for n in source.namelist()
                    if Path(n).parent.name == case and Path(n).suffix.lower() in (".hwp",".hwpx")]
    folders = [p for p in root.rglob(case) if p.is_dir()]
    if len(folders) != 1:
        raise FileNotFoundError(f"공식 테스트 ZIP 또는 압축을 푼 {case} 폴더를 확인하세요.")
    return [(p.name,p.read_bytes()) for p in sorted(folders[0].iterdir()) if p.suffix.lower() in (".hwp",".hwpx")]
