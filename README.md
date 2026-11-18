# AI and Law in India: Research Repository

A searchable collection of academic scholarship on artificial intelligence and law in India. Every paper shows how reliable its journal is, from indexed peer-reviewed journals to unreviewed preprints.

**Live site:** https://riyanvn.github.io/ai-journals-catalogue/

## How this repository is updated

Do not edit the files here by hand. The site is generated from the master spreadsheet (`Repository Master.xlsx`, kept privately) by `update_site.py`, and pushed here by `Update website.command`. Each run rebuilds `data/` and the downloadable database in `data/downloads/`.

## Data

- `data/papers.json`, `data/journals.json`: the data the site runs on.
- `data/downloads/repository.sqlite`: the full database as one SQLite file.
- `data/downloads/repository-csv.zip`: the same tables as CSV, with a README describing every field.

The search runs entirely in the browser; there is no server.
