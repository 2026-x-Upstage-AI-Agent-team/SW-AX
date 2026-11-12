"""Entry point shared by the installer, logon worker and swax-pc:// handler."""
from pathlib import Path
import sys

def action_for(args,installer):
    if args==['--background']:return 'background'
    if len(args)==1 and args[0].startswith('swax-pc:'):return 'connect'
    if installer and args in ([],['--install'],['--install','--quiet']):return 'install'
    if not args:return 'open'
    raise ValueError('Unexpected connector arguments')

def main():
    from pc_connector.windows import SERVER,executable,install,notice,start_worker
    try:
        args=sys.argv[1:]
        installer=bool(getattr(sys,'frozen',False) and Path(sys.executable).resolve()!=executable().resolve())
        action=action_for(args,installer)
        if action=='background':
            from pc_connector.agent import run
            run()
        elif action=='connect':
            from pc_connector.agent import connect
            login=connect(args[0])
            if login:
                start_worker()
                notice(login+' 계정과 이 PC를 연결했습니다.\n웹에서 연결 상태를 확인해 주세요.')
        elif action=='install':
            install(quiet='--quiet' in args)
        else:
            import webbrowser
            start_worker()
            webbrowser.open(SERVER+'/#/pc-connect')
    except Exception as error:
        if '--background' in sys.argv:
            raise SystemExit(1)
        # No raw server response or document contents are shown in the installation UI.
        notice('PC 연결을 완료하지 못했습니다.\n웹에서 새 연결 코드를 발급한 뒤 다시 시도하세요.\n\n오류 종류: '+type(error).__name__,error=True)

if __name__=='__main__':main()
