"""Importa o CSV CNEFE 2022 para uma base SQLite compacta e indexada."""

from __future__ import annotations

import csv
import json
import math
import sqlite3
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent
CSV_PADRAO = BASE_DIR / "cnefe_2022_domicilios_ruas_municipios_selecionados.csv"
DB_PADRAO = BASE_DIR / "cnefe.sqlite"
LIMITES_PATH = BASE_DIR / "static" / "limites-municipais.geojson"


def chave_texto(valor: str) -> str:
    texto = unicodedata.normalize("NFKD", valor.strip())
    return " ".join(texto.encode("ascii", "ignore").decode().upper().split())


def nome_logradouro(tipo: str, titulo: str, nome: str) -> str:
    return " ".join(parte.strip() for parte in (tipo, titulo, nome) if parte.strip())


def produto_vetorial(o: tuple[float, float], a: tuple[float, float], b: tuple[float, float]) -> float:
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])


def casco_convexo(pontos: set[tuple[float, float]]) -> list[list[float]]:
    """Retorna o casco convexo como pares [latitude, longitude]."""
    ordenados = sorted((lon, lat) for lat, lon in pontos)
    if len(ordenados) <= 2:
        return [[lat, lon] for lon, lat in ordenados]

    inferior: list[tuple[float, float]] = []
    for ponto in ordenados:
        while len(inferior) >= 2 and produto_vetorial(inferior[-2], inferior[-1], ponto) <= 0:
            inferior.pop()
        inferior.append(ponto)

    superior: list[tuple[float, float]] = []
    for ponto in reversed(ordenados):
        while len(superior) >= 2 and produto_vetorial(superior[-2], superior[-1], ponto) <= 0:
            superior.pop()
        superior.append(ponto)

    return [[lat, lon] for lon, lat in inferior[:-1] + superior[:-1]]


def criar_schema(conexao: sqlite3.Connection) -> None:
    conexao.executescript(
        """
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;

        CREATE TABLE metadata (
            chave TEXT PRIMARY KEY,
            valor TEXT NOT NULL
        );

        CREATE TABLE municipios (
            codigo INTEGER PRIMARY KEY,
            nome TEXT NOT NULL UNIQUE,
            domicilios INTEGER NOT NULL,
            limite_geojson TEXT
        );

        CREATE TABLE bairros (
            id INTEGER PRIMARY KEY,
            codigo_municipio INTEGER NOT NULL REFERENCES municipios(codigo),
            chave_geografica TEXT NOT NULL UNIQUE,
            nome TEXT NOT NULL,
            nome_original TEXT NOT NULL,
            domicilios INTEGER NOT NULL,
            latitude REAL NOT NULL,
            longitude REAL NOT NULL,
            contorno_json TEXT NOT NULL
        );

        CREATE TABLE ruas (
            id INTEGER PRIMARY KEY,
            bairro_id INTEGER NOT NULL REFERENCES bairros(id),
            nome TEXT NOT NULL,
            nome_busca TEXT NOT NULL,
            domicilios INTEGER NOT NULL,
            latitude REAL NOT NULL,
            longitude REAL NOT NULL,
            UNIQUE (bairro_id, nome_busca)
        );

        CREATE INDEX idx_bairros_municipio ON bairros(codigo_municipio, domicilios DESC);
        CREATE INDEX idx_ruas_bairro ON ruas(bairro_id, domicilios DESC);
        """
    )


def carregar_limites_municipais() -> dict[int, str]:
    if not LIMITES_PATH.exists():
        return {}
    colecao = json.loads(LIMITES_PATH.read_text(encoding="utf-8"))
    return {
        int(feature["properties"]["codarea"]): json.dumps(
            feature["geometry"], ensure_ascii=False, separators=(",", ":")
        )
        for feature in colecao.get("features", [])
        if feature.get("properties", {}).get("codarea") and feature.get("geometry")
    }


def importar(csv_path: Path = CSV_PADRAO, db_path: Path = DB_PADRAO) -> None:
    if not csv_path.exists():
        raise FileNotFoundError(f"CSV não encontrado: {csv_path}")

    municipios: dict[int, dict[str, object]] = {}
    bairros: dict[str, dict[str, object]] = {}
    ruas: dict[tuple[str, str], dict[str, object]] = {}
    pontos: dict[str, set[tuple[float, float]]] = defaultdict(set)
    limites_municipais = carregar_limites_municipais()
    total = 0

    print(f"Lendo {csv_path.name}...")
    with csv_path.open("r", encoding="utf-8-sig", newline="") as arquivo:
        leitor = csv.reader(arquivo)
        cabecalho = next(leitor)
        if len(cabecalho) < 15:
            raise ValueError("O CSV não possui as 15 colunas esperadas.")

        for linha in leitor:
            if len(linha) < 15:
                continue
            try:
                codigo_municipio = int(linha[1])
                latitude = float(linha[13])
                longitude = float(linha[14])
            except ValueError:
                continue
            if not (math.isfinite(latitude) and math.isfinite(longitude)):
                continue

            municipio = linha[2].strip()
            bairro_original = linha[3].strip()
            bairro_nome = linha[4].strip() or bairro_original
            chave_geo = linha[5].strip() or f"{codigo_municipio}|{bairro_nome}"
            rua_nome = nome_logradouro(linha[7], linha[8], linha[9])
            rua_busca = chave_texto(rua_nome)
            if not rua_busca:
                continue

            total += 1
            municipio_item = municipios.setdefault(
                codigo_municipio, {"nome": municipio, "domicilios": 0}
            )
            municipio_item["domicilios"] = int(municipio_item["domicilios"]) + 1

            bairro_item = bairros.setdefault(
                chave_geo,
                {
                    "codigo_municipio": codigo_municipio,
                    "nome": bairro_nome,
                    "nome_original": bairro_original,
                    "domicilios": 0,
                    "soma_lat": 0.0,
                    "soma_lon": 0.0,
                },
            )
            bairro_item["domicilios"] = int(bairro_item["domicilios"]) + 1
            bairro_item["soma_lat"] = float(bairro_item["soma_lat"]) + latitude
            bairro_item["soma_lon"] = float(bairro_item["soma_lon"]) + longitude
            pontos[chave_geo].add((round(latitude, 6), round(longitude, 6)))

            rua_item = ruas.setdefault(
                (chave_geo, rua_busca),
                {"nome": rua_nome, "domicilios": 0, "soma_lat": 0.0, "soma_lon": 0.0},
            )
            rua_item["domicilios"] = int(rua_item["domicilios"]) + 1
            rua_item["soma_lat"] = float(rua_item["soma_lat"]) + latitude
            rua_item["soma_lon"] = float(rua_item["soma_lon"]) + longitude

            if total % 200_000 == 0:
                print(f"  {total:,} endereços processados".replace(",", "."))

    temporario = db_path.with_suffix(".sqlite.tmp")
    temporario.unlink(missing_ok=True)
    conexao = sqlite3.connect(temporario)
    try:
        criar_schema(conexao)
        conexao.executemany(
            "INSERT INTO municipios(codigo, nome, domicilios, limite_geojson) VALUES (?, ?, ?, ?)",
            [
                (codigo, item["nome"], item["domicilios"], limites_municipais.get(codigo))
                for codigo, item in sorted(municipios.items())
            ],
        )

        bairro_ids: dict[str, int] = {}
        for bairro_id, (chave_geo, item) in enumerate(
            sorted(bairros.items(), key=lambda par: (int(par[1]["codigo_municipio"]), str(par[1]["nome"]))),
            start=1,
        ):
            quantidade = int(item["domicilios"])
            bairro_ids[chave_geo] = bairro_id
            conexao.execute(
                """
                INSERT INTO bairros(
                    id, codigo_municipio, chave_geografica, nome, nome_original,
                    domicilios, latitude, longitude, contorno_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    bairro_id,
                    item["codigo_municipio"],
                    chave_geo,
                    item["nome"],
                    item["nome_original"],
                    quantidade,
                    float(item["soma_lat"]) / quantidade,
                    float(item["soma_lon"]) / quantidade,
                    json.dumps(casco_convexo(pontos[chave_geo]), separators=(",", ":")),
                ),
            )

        linhas_ruas = []
        for (chave_geo, rua_busca), item in ruas.items():
            quantidade = int(item["domicilios"])
            linhas_ruas.append(
                (
                    bairro_ids[chave_geo],
                    item["nome"],
                    rua_busca,
                    quantidade,
                    float(item["soma_lat"]) / quantidade,
                    float(item["soma_lon"]) / quantidade,
                )
            )
        conexao.executemany(
            """
            INSERT INTO ruas(bairro_id, nome, nome_busca, domicilios, latitude, longitude)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            linhas_ruas,
        )
        conexao.executemany(
            "INSERT INTO metadata(chave, valor) VALUES (?, ?)",
            [
                ("fonte", "CNEFE — Censo Demográfico 2022 — IBGE"),
                ("arquivo", csv_path.name),
                ("enderecos", str(total)),
                ("municipios", str(len(municipios))),
                ("bairros", str(len(bairros))),
                ("ruas", str(len(ruas))),
            ],
        )
        conexao.commit()
        conexao.execute("PRAGMA optimize")
        conexao.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        conexao.execute("PRAGMA journal_mode = DELETE")
    finally:
        conexao.close()

    db_path.unlink(missing_ok=True)
    temporario.replace(db_path)
    print(
        f"Base criada: {db_path.name} — {total:,} endereços, "
        f"{len(municipios)} municípios, {len(bairros)} bairros e {len(ruas):,} ruas."
        .replace(",", ".")
    )


if __name__ == "__main__":
    origem = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else CSV_PADRAO
    destino = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else DB_PADRAO
    importar(origem, destino)
