import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace

from docx import Document as WordDocument
from openpyxl import Workbook
from pptx import Presentation

from office_loader import load_office_documents
from ingestor import DataIngestor


class OfficeLoaderTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)

    def test_word_body_and_table_order(self):
        path = self.root / 'policy.docx'
        document = WordDocument()
        document.add_paragraph('Policy starts')
        document.add_table(rows=1, cols=1).cell(0, 0).text = 'Table evidence'
        document.add_paragraph('Policy ends')
        document.save(path)
        with patch('ingestor.ChatGroq'):
            ingestor = DataIngestor()
        with patch.object(ingestor, 'audit_image', side_effect=AssertionError('Office must not call vision')):
            documents = ingestor.ingestion_documents(str(path))
        text = documents[0].page_content
        self.assertLess(text.index('Policy starts'), text.index('Table evidence'))
        self.assertLess(text.index('Table evidence'), text.index('Policy ends'))
        self.assertEqual(documents[0].metadata['source_name'], path.name)

    def test_excel_multiple_sheets_formulas_and_zero(self):
        path = self.root / 'budget.xlsx'
        workbook = Workbook()
        workbook.active.title = 'Budget'
        workbook.active.append(['Amount', 0, '=1+2'])
        workbook.create_sheet('Owners').append(['Alice', 'Finance'])
        workbook.save(path)
        workbook.close()
        documents = load_office_documents(str(path))
        self.assertEqual([doc.metadata['sheet'] for doc in documents], ['Budget', 'Owners'])
        self.assertIn('Amount | 0 | =1+2', documents[0].page_content)
        self.assertIn('Alice | Finance', documents[1].page_content)

    def test_powerpoint_slide_table_and_notes(self):
        path = self.root / 'report.pptx'
        presentation = Presentation()
        slide = presentation.slides.add_slide(presentation.slide_layouts[1])
        slide.shapes.title.text = 'Quarterly report'
        slide.shapes.add_table(1, 1, 0, 0, 1000000, 1000000).table.cell(0, 0).text = 'Revenue 42'
        slide.notes_slide.notes_text_frame.text = 'Discuss growth'
        presentation.save(path)
        documents = load_office_documents(str(path))
        self.assertEqual(documents[0].metadata['page'], 1)
        for text in ('Quarterly report', 'Revenue 42', 'Discuss growth'):
            self.assertIn(text, documents[0].page_content)

    def test_legacy_requires_libreoffice(self):
        with patch('office_loader.shutil.which', return_value=None):
            for extension in ('.doc', '.xls', '.ppt'):
                with self.subTest(extension=extension), self.assertRaisesRegex(RuntimeError, 'require LibreOffice'):
                    load_office_documents(str(self.root / ('old' + extension)))

    def test_legacy_word_conversion(self):
        def convert(command, **kwargs):
            output_directory = command[command.index('--outdir') + 1]
            document = WordDocument()
            document.add_paragraph('Converted legacy text')
            document.save(Path(output_directory, 'old.docx'))
            return SimpleNamespace(returncode=0, stdout='', stderr='')

        with patch('office_loader.shutil.which', return_value='/usr/bin/libreoffice'), patch('office_loader.subprocess.run', side_effect=convert):
            documents = load_office_documents(str(self.root / 'old.doc'))
        self.assertIn('Converted legacy text', documents[0].page_content)

    def test_corrupt_office_file_is_not_silently_accepted(self):
        path = self.root / 'broken.docx'
        path.write_text('Not a Word document')
        with self.assertRaises(Exception):
            load_office_documents(str(path))


if __name__ == '__main__':
    unittest.main()
