"""PyInstaller entry point for the self-contained Unum backend."""

from multiprocessing import freeze_support

from unum_core.main import run


if __name__ == "__main__":
    freeze_support()
    run()
