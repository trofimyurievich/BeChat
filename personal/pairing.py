class PairingFailure(Exception):
    def __init__(self, reason):
        self.reason = reason
        super().__init__(reason)


def code_problem(error):
    # Inspect the provider description locally. Only a fixed category leaves the worker.
    text = " ".join(str(getattr(error, key, "") or "").lower() for key in ("error","message","localized_message"))
    if any(term in text for term in ("limit","frequent","flood","слишком часто","много попыток")):
        return "RateLimit"
    if any(term in text for term in ("expired","timeout","истек","истёк","просроч","устарел")):
        return "CodeExpired"
    if any(term in text for term in ("wrong code","incorrect code","invalid code","invalid_code","code.invalid","verify.code","неверный код","код невер","неправильный код")):
        return "CodeRejected"
    return "ConfirmationDenied"
