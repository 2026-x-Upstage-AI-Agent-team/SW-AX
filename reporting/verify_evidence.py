"""Check that each report attachment matches its independently rendered source."""

import argparse
from collections import Counter
from hashlib import sha256
from pathlib import Path

from pypdf import PdfReader


def image_pixels(page):
    result = Counter()
    for embedded in page.images:
        image = embedded.image.convert("RGBA")
        result[(image.size, sha256(image.tobytes()).digest())] += 1
    return result


def verify(report, cover_pages, references):
    with report.open("rb") as stream:
        pages = PdfReader(stream).pages
        index = cover_pages
        for reference in references:
            with reference.open("rb") as source:
                for page_number, original in enumerate(PdfReader(source).pages, start=1):
                    if index >= len(pages):
                        raise ValueError(f"Missing page {page_number} of {reference.name}")
                    actual = pages[index]
                    pos = f"Report p.{index + 1}, {reference.name} p.{page_number}"
                    if (original.mediabox != actual.mediabox or original.cropbox != actual.cropbox
                            or original.rotation != actual.rotation):
                        raise ValueError(f"{pos}: page dimensions or rotation changed")
                    if original.extract_text() != actual.extract_text():
                        raise ValueError(f"{pos}: text differs from the original")
                    if image_pixels(original) != image_pixels(actual):
                        raise ValueError(f"{pos}: embedded image pixels differ from the original")
                    index += 1
        if index != len(pages):
            raise ValueError(f"Expected {index} pages, got {len(pages)}")
    return index - cover_pages


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    parser.add_argument("cover_pages", type=int)
    parser.add_argument("references", nargs="+", type=Path)
    args = parser.parse_args()
    count = verify(args.report, args.cover_pages, args.references)
    print(f"Verified dimensions, text and embedded images on {count} evidence pages.")
