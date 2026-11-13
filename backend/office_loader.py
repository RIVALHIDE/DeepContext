"""Extract Office text locally, converting legacy formats with LibreOffice."""

from pathlib import Path
import shutil
import subprocess
import tempfile

from langchain_core.documents import Document

OFFICE_EXTENSIONS = {'.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'}


def load_office_documents(file_path: str) -> list[Document]:
    path = Path(file_path).resolve()
    extension = path.suffix.lower()
    if extension in {'.doc', '.xls', '.ppt'}:
        executable = shutil.which('libreoffice') or shutil.which('soffice')
        if not executable:
            raise RuntimeError('Legacy Office files require LibreOffice. Install libreoffice-writer, libreoffice-calc and libreoffice-impress, or save as DOCX/XLSX/PPTX.')
        target = {'.doc': 'docx', '.xls': 'xlsx', '.ppt': 'pptx'}[extension]
        with tempfile.TemporaryDirectory(prefix='deepcontext-office-') as directory:
            profile = Path(directory, 'profile').as_uri()
            result = subprocess.run(
                [executable, f'-env:UserInstallation={profile}', '--headless', '--convert-to', target,
                 '--outdir', directory, str(path)],
                capture_output=True, text=True, timeout=120, check=False,
            )
            converted = Path(directory, f'{path.stem}.{target}')
            if result.returncode or not converted.exists():
                raise RuntimeError(f'Office conversion failed: {result.stderr.strip() or result.stdout.strip()}')
            return load_office_documents(str(converted))

    documents = []
    if extension == '.docx':
        from docx import Document as WordDocument
        document = WordDocument(str(path))
        # iter_inner_content preserves paragraph/table order in the document body.
        blocks = []
        for block in document.iter_inner_content():
            if hasattr(block, 'rows'):
                blocks.extend(' | '.join(cell.text for cell in row.cells) for row in block.rows)
            else:
                blocks.append(block.text)
        documents.append(Document(page_content='\n'.join(blocks), metadata={'content_type': 'word'}))
    elif extension == '.xlsx':
        from openpyxl import load_workbook
        workbook = load_workbook(str(path), read_only=True, data_only=False)
        try:
            for index, sheet in enumerate(workbook.worksheets, start=1):
                rows = [' | '.join('' if value is None else str(value) for value in row)
                        for row in sheet.iter_rows(values_only=True) if any(value is not None for value in row)]
                if rows:
                    documents.append(Document(page_content=f'Sheet: {sheet.title}\n' + '\n'.join(rows),
                                              metadata={'content_type': 'spreadsheet', 'sheet': sheet.title, 'page': index}))
        finally:
            workbook.close()
    elif extension == '.pptx':
        from pptx import Presentation

        def shape_text(shapes):
            blocks = []
            for shape in shapes:
                if shape.has_text_frame:
                    blocks.append(shape.text_frame.text)
                if shape.has_table:
                    blocks.extend(' | '.join(cell.text for cell in row.cells) for row in shape.table.rows)
                if hasattr(shape, 'shapes'):
                    blocks.extend(shape_text(shape.shapes))
            return blocks

        for index, slide in enumerate(Presentation(str(path)).slides, start=1):
            blocks = shape_text(slide.shapes)
            if slide.has_notes_slide:
                notes = slide.notes_slide.notes_text_frame
                if notes and notes.text.strip():
                    blocks.append('Speaker notes: ' + notes.text)
            if any(block.strip() for block in blocks):
                documents.append(Document(page_content=f'Slide {index}\n' + '\n'.join(blocks),
                                          metadata={'content_type': 'presentation', 'page': index}))
    else:
        raise ValueError(f'Unsupported Office extension: {extension}')
    return [document for document in documents if document.page_content.strip()]
