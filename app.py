"""Aplicação local MapBairros: FastAPI + HTMX + SQLite."""

from __future__ import annotations

import json
import math
import sqlite3
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates


BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "cnefe.sqlite"

app = FastAPI(title="MapBairros", docs_url=None, redoc_url=None)
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")


def conectar() -> sqlite3.Connection:
    if not DB_PATH.exists():
        raise HTTPException(
            status_code=503,
            detail="Base CNEFE ausente. Execute importar_dados.py antes de iniciar.",
        )
    conexao = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    conexao.row_factory = sqlite3.Row
    return conexao


def nome_exibicao(nome: str) -> str:
    preposicoes = {"DA", "DAS", "DE", "DO", "DOS", "E"}
    palavras = nome.strip().split()
    return " ".join(
        palavra.lower() if indice and palavra.upper() in preposicoes else palavra.capitalize()
        for indice, palavra in enumerate(palavras)
    )


def listar_municipios(conexao: sqlite3.Connection) -> list[dict[str, object]]:
    return [
        {**dict(linha), "nome_exibicao": nome_exibicao(linha["nome"])}
        for linha in conexao.execute(
            "SELECT codigo, nome, domicilios FROM municipios ORDER BY nome COLLATE NOCASE"
        )
    ]


def listar_bairros(conexao: sqlite3.Connection, municipio: int) -> list[dict[str, object]]:
    return [
        {**dict(linha), "nome_exibicao": nome_exibicao(linha["nome"])}
        for linha in conexao.execute(
            """
            SELECT id, nome, domicilios
            FROM bairros
            WHERE codigo_municipio = ?
            ORDER BY domicilios DESC, nome COLLATE NOCASE
            """,
            (municipio,),
        )
    ]


def distancia_quadrada(a: dict[str, object], b: dict[str, object]) -> float:
    latitude_media = math.radians((float(a["latitude"]) + float(b["latitude"])) / 2)
    dx = (float(a["longitude"]) - float(b["longitude"])) * math.cos(latitude_media)
    dy = float(a["latitude"]) - float(b["latitude"])
    return dx * dx + dy * dy


def escolher_sementes(ruas: list[dict[str, object]], quantidade: int) -> list[int]:
    primeira = max(range(len(ruas)), key=lambda indice: int(ruas[indice]["domicilios"]))
    sementes = [primeira]
    while len(sementes) < quantidade:
        candidato = max(
            (indice for indice in range(len(ruas)) if indice not in sementes),
            key=lambda indice: min(
                distancia_quadrada(ruas[indice], ruas[semente]) for semente in sementes
            ),
        )
        sementes.append(candidato)
    return sementes


def dividir_ruas(ruas: list[dict[str, object]], quantidade: int) -> list[dict[str, object]]:
    """Agrupa ruas buscando proximidade geográfica e equilíbrio de domicílios."""
    quantidade = max(1, min(quantidade, len(ruas)))
    sementes = escolher_sementes(ruas, quantidade)
    equipes = [
        {
            "ruas": [ruas[indice]],
            "domicilios": int(ruas[indice]["domicilios"]),
            "soma_lat": float(ruas[indice]["latitude"]) * int(ruas[indice]["domicilios"]),
            "soma_lon": float(ruas[indice]["longitude"]) * int(ruas[indice]["domicilios"]),
        }
        for indice in sementes
    ]
    restantes = [
        rua
        for indice, rua in enumerate(ruas)
        if indice not in set(sementes)
    ]
    restantes.sort(key=lambda rua: int(rua["domicilios"]), reverse=True)
    alvo = sum(int(rua["domicilios"]) for rua in ruas) / quantidade

    for rua in restantes:
        distancias = []
        for equipe in equipes:
            peso = max(1, int(equipe["domicilios"]))
            centro = {
                "latitude": float(equipe["soma_lat"]) / peso,
                "longitude": float(equipe["soma_lon"]) / peso,
            }
            distancias.append(distancia_quadrada(rua, centro))
        distancia_maxima = max(distancias) or 1

        def pontuacao(indice: int) -> float:
            carga_projetada = int(equipes[indice]["domicilios"]) + int(rua["domicilios"])
            carga = carga_projetada / max(1, alvo)
            proximidade = distancias[indice] / distancia_maxima
            return carga * 2.4 + proximidade

        escolhida = min(range(quantidade), key=pontuacao)
        equipe = equipes[escolhida]
        peso_rua = int(rua["domicilios"])
        equipe["ruas"].append(rua)
        equipe["domicilios"] = int(equipe["domicilios"]) + peso_rua
        equipe["soma_lat"] = float(equipe["soma_lat"]) + float(rua["latitude"]) * peso_rua
        equipe["soma_lon"] = float(equipe["soma_lon"]) + float(rua["longitude"]) * peso_rua

    resultado = []
    for numero, equipe in enumerate(equipes, start=1):
        ruas_equipe = sorted(
            equipe["ruas"], key=lambda rua: (-int(rua["domicilios"]), str(rua["nome"]))
        )
        resultado.append(
            {
                "numero": numero,
                "domicilios": equipe["domicilios"],
                "ruas": ruas_equipe,
                "quantidade_ruas": len(ruas_equipe),
            }
        )
    return resultado


@app.get("/", response_class=HTMLResponse)
def pagina_inicial(request: Request):
    with conectar() as conexao:
        municipios = listar_municipios(conexao)
        preferido = next(
            (item for item in municipios if item["nome"] == "Santana de Parnaíba"),
            municipios[0] if municipios else None,
        )
        bairros = listar_bairros(conexao, int(preferido["codigo"])) if preferido else []
        metadata = {
            linha["chave"]: linha["valor"]
            for linha in conexao.execute("SELECT chave, valor FROM metadata")
        }
    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={
            "municipios": municipios,
            "municipio_selecionado": preferido,
            "bairros": bairros,
            "metadata": metadata,
            "enderecos_formatado": f"{int(metadata.get('enderecos', 0)):,}".replace(",", "."),
        },
    )


@app.get("/bairros", response_class=HTMLResponse)
def bairros_fragmento(request: Request, municipio: int = Query(...)):
    with conectar() as conexao:
        bairros = listar_bairros(conexao, municipio)
    if not bairros:
        raise HTTPException(status_code=404, detail="Município sem bairros cadastrados.")
    return templates.TemplateResponse(
        request=request,
        name="resultados.html",
        context={"fragmento": "bairros", "bairros": bairros},
        headers={"Vary": "HX-Request"},
    )


@app.get("/divisao", response_class=HTMLResponse)
def divisao_fragmento(
    request: Request,
    municipio: int = Query(...),
    bairro: int = Query(...),
    equipes: int = Query(10, ge=2, le=30),
):
    with conectar() as conexao:
        bairro_linha = conexao.execute(
            """
            SELECT b.*, m.nome AS municipio_nome, m.limite_geojson AS municipio_limite_geojson
            FROM bairros b
            JOIN municipios m ON m.codigo = b.codigo_municipio
            WHERE b.id = ? AND b.codigo_municipio = ?
            """,
            (bairro, municipio),
        ).fetchone()
        if bairro_linha is None:
            raise HTTPException(status_code=404, detail="Bairro não encontrado.")
        ruas = [
            {
                **dict(linha),
                "nome_exibicao": nome_exibicao(linha["nome"]),
            }
            for linha in conexao.execute(
                """
                SELECT id, nome, domicilios, latitude, longitude
                FROM ruas WHERE bairro_id = ? ORDER BY domicilios DESC
                """,
                (bairro,),
            )
        ]
        bairros_municipio = [
            {
                "id": linha["id"],
                "nome": nome_exibicao(linha["nome"]),
                "contorno": json.loads(linha["contorno_json"]),
                "selecionado": linha["id"] == bairro,
            }
            for linha in conexao.execute(
                """
                SELECT id, nome, contorno_json
                FROM bairros
                WHERE codigo_municipio = ?
                ORDER BY nome COLLATE NOCASE
                """,
                (municipio,),
            )
        ]

    if len(ruas) < 2:
        raise HTTPException(status_code=422, detail="O bairro não possui ruas suficientes.")
    equipes_resultado = dividir_ruas(ruas, equipes)
    totais = [int(equipe["domicilios"]) for equipe in equipes_resultado]
    bairro_dados = dict(bairro_linha)
    bairro_dados["nome_exibicao"] = nome_exibicao(bairro_dados["nome"])
    bairro_dados["municipio_exibicao"] = nome_exibicao(bairro_dados["municipio_nome"])

    mapa = {
        "bairro": bairro_dados["nome_exibicao"],
        "municipio": bairro_dados["municipio_exibicao"],
        "codigo_municipio": bairro_dados["codigo_municipio"],
        "centro": [bairro_dados["latitude"], bairro_dados["longitude"]],
        "contorno": json.loads(bairro_dados["contorno_json"]),
        "limite_municipio": (
            json.loads(bairro_dados["municipio_limite_geojson"])
            if bairro_dados.get("municipio_limite_geojson")
            else None
        ),
        "bairros_municipio": bairros_municipio,
        "ruas": [
            {
                "nome": rua["nome_exibicao"],
                "domicilios": rua["domicilios"],
                "lat": rua["latitude"],
                "lon": rua["longitude"],
                "equipe": equipe["numero"],
            }
            for equipe in equipes_resultado
            for rua in equipe["ruas"]
        ],
    }
    return templates.TemplateResponse(
        request=request,
        name="resultados.html",
        context={
            "fragmento": "divisao",
            "bairro": bairro_dados,
            "equipes": equipes_resultado,
            "total_ruas": len(ruas),
            "total_domicilios": sum(totais),
            "diferenca": max(totais) - min(totais),
            "mapa": mapa,
        },
        headers={"Vary": "HX-Request", "Cache-Control": "no-store"},
    )


@app.get("/saude")
def saude():
    return {"status": "ok", "base": DB_PATH.exists()}
